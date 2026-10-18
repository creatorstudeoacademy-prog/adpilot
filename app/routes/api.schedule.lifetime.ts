import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import {
  LIFETIME_BILLING_DAYS,
  LIFETIME_MAX_POSTS_PER_DAY,
  LIFETIME_PACKS,
  lifetimeFee,
} from "../lib/pricing";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/schedule/lifetime
 * Body: { action: "activate", packId, topic, goal, socialAccountId, postTime }
 *      | { action: "cancel" } | { action: "toggle-renew" }
 *
 * - activate: charges 90 days upfront (25% off), locks for 3 months, no cancel before endsAt.
 *   The daily worker generates postsPerDay AI posts every day until endsAt.
 * - cancel: only allowed after the 3-month lock (sets autoRenew=false, status stays active till endsAt).
 * - toggle-renew: flips autoRenew.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { action?: unknown; postsPerDay?: unknown; packId?: unknown; topic?: unknown; goal?: unknown; socialAccountId?: unknown; postTime?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const act = String(body.action ?? "");

  const existing = await prisma.lifetimePackage.findFirst({
    where: { shop, status: "active" },
    orderBy: { createdAt: "desc" },
  });

  if (act === "activate") {
    if (existing) {
      return json(
        { ok: false, error: "ALREADY_ACTIVE", message: "Lifetime package is already active." },
        { status: 400 },
      );
    }
    const pack = LIFETIME_PACKS.find((p) => p.id === String(body.packId ?? ""));
    const postsPerDay = pack
      ? pack.postsPerDay
      : Math.max(1, Math.min(LIFETIME_MAX_POSTS_PER_DAY, Math.floor(Number(body.postsPerDay) || 1)));
    const fee = lifetimeFee(postsPerDay);

    // Generation config — required so the daily worker knows what to post.
    const topic = String(body.topic ?? "").trim().slice(0, 500);
    const goal = String(body.goal ?? "").trim().slice(0, 200) || "Increase Sales";
    const socialAccountId = String(body.socialAccountId ?? "").trim();
    const postTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.postTime ?? ""))
      ? String(body.postTime)
      : "09:00";
    if (!topic) {
      return json(
        { ok: false, error: "MISSING_TOPIC", message: "Please tell us what the posts should be about." },
        { status: 400 },
      );
    }
    const page = socialAccountId
      ? await prisma.socialAccount.findFirst({ where: { id: socialAccountId, shop } })
      : null;
    if (!page) {
      return json(
        { ok: false, error: "NO_PAGE", message: "Please select a Facebook Page." },
        { status: 400 },
      );
    }

    const wallet = await getWallet(shop);
    if (!isFreeShop(shop) && wallet.balance < fee) {
      return json(
        {
          ok: false,
          error: "INSUFFICIENT_WALLET",
          message: `Insufficient balance ($${wallet.balance.toFixed(2)}). 3 months costs $${fee.toFixed(2)} — please top up.`,
        },
        { status: 402 },
      );
    }
    if (!isFreeShop(shop)) {
      await deduct(shop, fee, `Lifetime Auto-Post (${postsPerDay}/day × 3 months)`);
    }

    const now = new Date();
    let rec;
    try {
      rec = await prisma.lifetimePackage.create({
        data: {
          shop,
          postsPerDay,
          feeCharged: isFreeShop(shop) ? 0 : fee,
          status: "active",
          autoRenew: true,
          startsAt: now,
          endsAt: new Date(now.getTime() + LIFETIME_BILLING_DAYS * 24 * 60 * 60 * 1000),
          topic,
          goal,
          socialAccountId: page.id,
          postTime,
          activeKey: shop, // atomic guard: unique → concurrent activates can't double-charge
        },
      });
    } catch (e) {
      // Unique violation on activeKey = another request activated concurrently. Refund.
      if (!isFreeShop(shop)) {
        await refund(shop, fee, "Refund: concurrent lifetime activation");
      }
      return json(
        { ok: false, error: "ALREADY_ACTIVE", message: "Lifetime package is already active." },
        { status: 400 },
      );
    }

    logActivity({
      shop,
      action: "lifetime_activated",
      detail: `${postsPerDay} posts/day × 3 months, $${fee.toFixed(2)}, topic: ${topic.slice(0, 60)}`,
      feeCharged: isFreeShop(shop) ? 0 : fee,
    });
    return json({ ok: true, id: rec.id, endsAt: rec.endsAt.toISOString() });
  }

  if (!existing) {
    return json({ ok: false, error: "NO_ACTIVE", message: "No active lifetime package." }, { status: 400 });
  }

  if (act === "toggle-renew") {
    const updated = await prisma.lifetimePackage.update({
      where: { id: existing.id },
      data: { autoRenew: !existing.autoRenew },
    });
    return json({ ok: true, autoRenew: updated.autoRenew });
  }

  if (act === "cancel") {
    // 3-month lock: cannot cancel before endsAt.
    if (new Date() < existing.endsAt) {
      const daysLeft = Math.ceil(
        (existing.endsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      );
      return json(
        {
          ok: false,
          error: "LOCKED",
          message: `Locked for the 3-month term — ${daysLeft} days left. You can turn off auto-renew instead.`,
        },
        { status: 400 },
      );
    }
    await prisma.lifetimePackage.update({
      where: { id: existing.id },
      data: { status: "cancelled", autoRenew: false },
    });
    logActivity({ shop, action: "lifetime_cancelled", detail: "Lifetime package cancelled" });
    return json({ ok: true });
  }

  if (act === "update-settings") {
    const topic = String(body.topic ?? "").trim().slice(0, 500);
    const goal = String(body.goal ?? "").trim().slice(0, 200) || "Increase Sales";
    const socialAccountId = String(body.socialAccountId ?? "").trim();
    const postTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.postTime ?? ""))
      ? String(body.postTime)
      : "09:00";
    if (!topic) {
      return json(
        { ok: false, error: "MISSING_TOPIC", message: "Please tell us what the posts should be about." },
        { status: 400 },
      );
    }
    const page = socialAccountId
      ? await prisma.socialAccount.findFirst({ where: { id: socialAccountId, shop } })
      : null;
    if (!page) {
      return json(
        { ok: false, error: "NO_PAGE", message: "Please select a Facebook Page." },
        { status: 400 },
      );
    }
    await prisma.lifetimePackage.update({
      where: { id: existing.id },
      data: { topic, goal, socialAccountId: page.id, postTime, lastGeneratedDate: null },
    });
    logActivity({ shop, action: "lifetime_settings_updated", detail: `Daily posts: ${topic} (${postTime} UTC)` });
    return json({ ok: true });
  }

  return json({ ok: false, error: "BAD_ACTION", message: "Unknown action." }, { status: 400 });
};
