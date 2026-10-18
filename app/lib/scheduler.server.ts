/**
 * Scheduled-post publishing worker (server-only).
 *
 * Every 60 seconds it finds ScheduledPosts with status "scheduled" whose
 * scheduledAt has passed, publishes each via the existing Meta publishing
 * helpers, and marks them "published" (or "failed" with the error message).
 *
 * The publish fee was already deducted at schedule time, so this worker never
 * charges again. Each post is claimed (status -> "publishing") before the Meta
 * API call so concurrent ticks can't double-publish (idempotent).
 */

import prisma from "../db.server";
import { publishToPlatforms } from "./meta.server";
import { isTokenExpiredError } from "./meta-ads.server";
import { logActivity } from "./activity.server";
import { deduct, getWallet, isFreeShop, refund } from "./wallet.server";
import { LIFETIME_BILLING_DAYS, POST_PUBLISH_FEE, lifetimeFee } from "./pricing";
import { chatWithProvider, resolveProvidersAsync } from "./ai.server";

export interface DuePassResult {
  published: number;
  failed: number;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Run one publishing pass over all due scheduled posts. */
export async function runDuePostsPass(): Promise<DuePassResult> {
  const result: DuePassResult = { published: 0, failed: 0 };
  const now = new Date();

  // Recover posts stuck in "publishing" (process died between claim and
  // update). Anything untouched for >5 min goes back to "scheduled".
  await prisma.scheduledPost.updateMany({
    where: {
      status: "publishing",
      updatedAt: { lt: new Date(now.getTime() - 5 * 60 * 1000) },
    },
    data: { status: "scheduled", error: "Recovered from an interrupted publish — will retry." },
  });

  // Per-shop fairness: split the 50-post budget across shops with due
  // posts so one busy shop can't starve the others in a pass.
  const shopsWithDue = await prisma.scheduledPost.findMany({
    where: { status: "scheduled", scheduledAt: { lte: now } },
    select: { shop: true },
    distinct: ["shop"],
  });
  const perShop = Math.max(1, Math.floor(50 / Math.max(1, shopsWithDue.length)));
  const dueLists = await Promise.all(
    shopsWithDue.map((s) =>
      prisma.scheduledPost.findMany({
        where: { status: "scheduled", scheduledAt: { lte: now }, shop: s.shop },
        include: { socialAccount: true },
        orderBy: { scheduledAt: "asc" },
        take: perShop,
      }),
    ),
  );
  const due = dueLists.flat();

  for (const post of due) {
    // Claim the post so a concurrent tick can't publish it twice.
    const claimed = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "scheduled" },
      data: { status: "publishing" },
    });
    if (claimed.count === 0) continue; // another tick claimed it first

    try {
      await publishToPlatforms({
        accessToken: post.socialAccount.accessToken,
        pageId: post.socialAccount.pageId,
        instagramId: post.socialAccount.instagramId,
        content: post.content,
        mediaUrls: parseJsonArray(post.mediaUrls),
        mediaType: post.mediaType,
        platforms: parseJsonArray(post.platforms),
      });
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "published", publishedAt: new Date(), error: null },
      });
      logActivity({
        shop: post.shop,
        action: "post_publish",
        detail: `post:${post.id} via:worker platforms:${parseJsonArray(post.platforms).join(",")}`,
        feeCharged: 0, // fee was already charged (and logged) at schedule time
      });
      result.published += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Publishing failed.";
      // Expired Meta token: NOT terminal — park the post back as "scheduled"
      // with a reconnect hint so it resumes after the merchant reconnects.
      if (isTokenExpiredError(e)) {
        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: {
            status: "scheduled",
            error: "Facebook connection expired — reconnect it in Accounts.",
          },
        });
        logActivity({
          shop: post.shop,
          action: "post_publish",
          detail: `post:${post.id} parked: Meta token expired, awaiting reconnect`,
          feeCharged: 0,
        });
        result.failed += 1;
        continue;
      }
      // Manual posts paid POST_PUBLISH_FEE at schedule time — refund it so a
      // worker failure doesn't keep the fee (consistent with publish-now).
      // Package/lifetime posts have no per-post fee, so nothing to refund.
      if (!post.schedulePackageId && !post.lifetimePackageId) {
        await refund(post.shop, POST_PUBLISH_FEE, `Refund: scheduled post failed in worker`, post.id);
      }
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "failed", error: message },
      });
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Start the in-process 60s interval. Safe to call multiple times (hot reloads):
 * only the first call takes effect. Never call during build.
 */
export function startScheduledPostWorker(intervalMs = 60_000): void {
  const g = globalThis as unknown as { __adpilotWorkerStarted?: boolean };
  if (g.__adpilotWorkerStarted) return;
  g.__adpilotWorkerStarted = true;

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap passes
    running = true;
    try {
      const r = await runDuePostsPass();
      if (r.published > 0 || r.failed > 0) {
        console.log(
          `[adpilot scheduler] pass complete: ${r.published} published, ${r.failed} failed`,
        );
      }
      const lt = await runLifetimePass();
      if (lt.generated > 0 || lt.renewed > 0 || lt.expired > 0) {
        console.log(
          `[adpilot scheduler] lifetime pass: ${lt.generated} generated, ${lt.renewed} renewed, ${lt.expired} expired`,
        );
      }
    } catch (e) {
      console.error("[adpilot scheduler] pass error:", e);
    } finally {
      running = false;
    }
  };

  // First pass shortly after boot so posts that came due during downtime
  // publish quickly, then every 60s.
  setTimeout(tick, 10_000);
  const timer = setInterval(tick, intervalMs);
  // Don't keep the process alive solely for the worker.
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

/* ── Lifetime Auto-Post daily pass ─────────────────────────────
 * For every active LifetimePackage:
 *  1. Expiry/renewal: when endsAt passes — autoRenew tries to deduct the
 *     next 3-month fee and extend; otherwise the package expires (activeKey
 *     cleared so the shop can buy again).
 *  2. Daily generation: once per day, AI-generates postsPerDay posts and
 *     creates them as scheduled ScheduledPosts (no per-post fee — prepaid).
 * Runs inside the 60s tick; the per-package date guard keeps it cheap.
 */

export interface LifetimePassResult {
  generated: number;
  renewed: number;
  expired: number;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parsePostTime(t: string): { h: number; m: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t ?? "");
  if (!m) return { h: 9, m: 0 };
  return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
}

/** Spread n posts across the day starting at base time. */
function spreadTimes(base: string, n: number, day: Date): Date[] {
  const { h, m } = parsePostTime(base);
  const intervalMin = n <= 3 ? 240 : n <= 5 ? 180 : 90;
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(day);
    d.setUTCHours(h, m, 0, 0);
    d.setUTCMinutes(d.getUTCMinutes() + i * intervalMin);
    out.push(d);
  }
  return out;
}

function extractJsonArray(raw: string): string[] {
  const cleaned = raw.trim().replace(/```(?:json)?\s*([\s\S]*?)```/, "$1").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  const parsed: unknown = JSON.parse(match ? match[0] : cleaned);
  if (!Array.isArray(parsed)) throw new Error("not array");
  const arr = parsed.map((c) => String(c).slice(0, 2000)).filter(Boolean);
  if (arr.length === 0) throw new Error("empty array");
  return arr;
}

async function generateLifetimeDayPosts(
  topic: string,
  goal: string,
  count: number,
): Promise<string[]> {
  const providers = await resolveProvidersAsync();
  if (providers.length === 0) throw new Error("AI_NOT_CONFIGURED");
  const systemPrompt = `You are a social media content writer for Facebook posts. Write engaging Facebook posts that are 3-5 sentences long (substantial, not one-liners). Each post must end with 3-5 relevant hashtags on a new line.

CRITICAL: Your ENTIRE response must be ONLY a valid JSON array of strings. No markdown, no code fences, no explanations.`;
  const userPrompt = `Goal: ${goal}\nTopic: ${topic}\nWrite ${count} different Facebook posts for today. Vary the angle for each post. Return ONLY the JSON array of ${count} post strings.`;
  let raw = "";
  let lastError: unknown = null;
  for (const cfg of providers) {
    try {
      raw = await chatWithProvider(cfg, systemPrompt, [{ role: "user", content: userPrompt }]);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!raw) throw lastError instanceof Error ? lastError : new Error("AI_FAILED");
  const contents = extractJsonArray(raw);
  while (contents.length < count) contents.push(contents[contents.length - 1]);
  return contents.slice(0, count);
}

export async function runLifetimePass(): Promise<LifetimePassResult> {
  const result: LifetimePassResult = { generated: 0, renewed: 0, expired: 0 };
  const now = new Date();
  const today = utcDay(now);

  // 1. Expiry / renewal.
  const dueExpiry = await prisma.lifetimePackage.findMany({
    where: { status: "active", endsAt: { lte: now } },
  });
  for (const pkg of dueExpiry) {
    if (pkg.autoRenew) {
      const fee = lifetimeFee(pkg.postsPerDay);
      let renewed = false;
      if (isFreeShop(pkg.shop)) {
        renewed = true; // owner's store: extend without charge
      } else {
        const wallet = await getWallet(pkg.shop);
        if (wallet.balance >= fee) {
          await deduct(pkg.shop, fee, `Lifetime Auto-Post renewal (${pkg.postsPerDay}/day × 3 months)`);
          renewed = true;
        }
      }
      if (renewed) {
        await prisma.lifetimePackage.update({
          where: { id: pkg.id },
          data: {
            endsAt: new Date(pkg.endsAt.getTime() + LIFETIME_BILLING_DAYS * 24 * 60 * 60 * 1000),
            lastGeneratedDate: null,
          },
        });
        logActivity({ shop: pkg.shop, action: "lifetime_renewed", detail: `${pkg.postsPerDay}/day × 3 months, $${fee.toFixed(2)}`, feeCharged: isFreeShop(pkg.shop) ? 0 : fee });
        result.renewed += 1;
        continue;
      }
      // Auto-renew on but wallet too low → expire (merchant can top up and buy again).
      logActivity({ shop: pkg.shop, action: "lifetime_expired", detail: "Auto-renew failed: insufficient wallet balance.", feeCharged: 0 });
    }
    await prisma.lifetimePackage.update({
      where: { id: pkg.id },
      data: { status: "expired", activeKey: null },
    });
    result.expired += 1;
  }

  // 2. Daily generation for active packages.
  const active = await prisma.lifetimePackage.findMany({
    where: { status: "active", startsAt: { lte: now }, endsAt: { gt: now } },
  });
  for (const pkg of active) {
    if (pkg.lastGeneratedDate && utcDay(pkg.lastGeneratedDate) === today) continue;
    if (!pkg.socialAccountId || !pkg.topic) {
      // Misconfigured (old record) — mark attempted so we don't retry every tick.
      await prisma.lifetimePackage.update({ where: { id: pkg.id }, data: { lastGeneratedDate: now } });
      continue;
    }
    const page = await prisma.socialAccount.findFirst({
      where: { id: pkg.socialAccountId, shop: pkg.shop },
    });
    if (!page) {
      await prisma.lifetimePackage.update({ where: { id: pkg.id }, data: { lastGeneratedDate: now } });
      logActivity({ shop: pkg.shop, action: "lifetime_generation_failed", detail: "Connected page not found.", feeCharged: 0 });
      continue;
    }
    try {
      const contents = await generateLifetimeDayPosts(pkg.topic, pkg.goal, pkg.postsPerDay);
      // Collision guard: never two posts at the same minute for this shop.
      const existing = await prisma.scheduledPost.findMany({
        where: { shop: pkg.shop, status: { in: ["scheduled", "publishing"] }, scheduledAt: { gte: now } },
        select: { scheduledAt: true },
      });
      const taken = new Set(
        existing.map((p) => (p.scheduledAt ? utcDay(p.scheduledAt) + "T" + p.scheduledAt.toISOString().slice(11, 16) : "")),
      );
      const times = spreadTimes(pkg.postTime, contents.length, now);
      const rows = contents.map((content, i) => {
        let at = times[i];
        let guard = 0;
        while (taken.has(utcDay(at) + "T" + at.toISOString().slice(11, 16)) && guard < 20) {
          at = new Date(at.getTime() + 30 * 60 * 1000);
          guard++;
        }
        taken.add(utcDay(at) + "T" + at.toISOString().slice(11, 16));
        return {
          shop: pkg.shop,
          socialAccountId: page.id,
          content,
          mediaType: "post",
          platforms: '["facebook"]',
          scheduledAt: at,
          status: "scheduled",
          lifetimePackageId: pkg.id,
        };
      });
      await prisma.scheduledPost.createMany({ data: rows });
      await prisma.lifetimePackage.update({ where: { id: pkg.id }, data: { lastGeneratedDate: now } });
      logActivity({ shop: pkg.shop, action: "lifetime_posts_generated", detail: `${rows.length} posts for ${today}`, feeCharged: 0 });
      result.generated += rows.length;
    } catch (e) {
      // One attempt per day — retry tomorrow, don't spam the tick.
      await prisma.lifetimePackage.update({ where: { id: pkg.id }, data: { lastGeneratedDate: now } });
      logActivity({
        shop: pkg.shop,
        action: "lifetime_generation_failed",
        detail: e instanceof Error ? e.message.slice(0, 200) : "AI generation failed",
        feeCharged: 0,
      });
    }
  }

  return result;
}
