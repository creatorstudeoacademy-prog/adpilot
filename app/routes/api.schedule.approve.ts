import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deduct, getWallet, isFreeShop } from "../lib/wallet.server";
import { SCHEDULE_PACKAGES, TEXT_POST_FEE } from "../lib/pricing";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/schedule/approve — approve AI-generated drafts: charge + schedule.
 * Body: { packageId, accountId, posts: [{ date: YYYY-MM-DD, content: string }] }
 * - Deducts package fee from wallet (or per-post fee if no package)
 * - Creates SchedulePackage record + ScheduledPost rows (status "scheduled")
 * Returns { ok, count } or { ok:false, error, message }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { packageId?: unknown; accountId?: unknown; posts?: unknown; idempotencyKey?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  // Idempotency: a client-generated key dedupes double-clicks/retries.
  const idempotencyKey = String(body.idempotencyKey ?? "").trim().slice(0, 64) || null;
  if (idempotencyKey) {
    const dup = await prisma.schedulePackage.findUnique({ where: { idempotencyKey } });
    if (dup && dup.shop === shop) {
      const count = await prisma.scheduledPost.count({ where: { schedulePackageId: dup.id } });
      return json({ ok: true, count, packageId: dup.id, deduped: true });
    }
  }

  const accountId = String(body.accountId ?? "").trim();
  const rawPosts = Array.isArray(body.posts) ? body.posts : [];
  const posts = rawPosts
    .filter(
      (p): p is { date: string; time?: string; content: string } =>
        !!p && typeof p === "object" &&
        typeof (p as { date?: unknown }).date === "string" &&
        typeof (p as { content?: unknown }).content === "string" &&
        String((p as { content: string }).content).trim().length > 0,
    )
    .map((p) => ({
      date: String(p.date).slice(0, 10),
      time: /^\d{2}:\d{2}$/.test(String(p.time ?? "")) ? String(p.time) : "09:00",
      content: String(p.content).trim().slice(0, 2000),
    }));

  if (!accountId || posts.length === 0) {
    return json(
      { ok: false, error: "MISSING_INPUT", message: "Select an account and add at least one post." },
      { status: 400 },
    );
  }

  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, shop },
  });
  if (!account) {
    return json({ ok: false, error: "BAD_ACCOUNT", message: "Account not found." }, { status: 400 });
  }

  const pkg = SCHEDULE_PACKAGES.find((p) => p.id === String(body.packageId ?? ""));
  // Fee: package fee if a valid package chosen, else per-post fee.
  // Packages can be bought unlimited times — no active-package restriction.
  const fee = pkg ? pkg.fee : posts.length * TEXT_POST_FEE;

  const wallet = await getWallet(shop);
  if (!isFreeShop(shop) && wallet.balance < fee) {
    return json(
      {
        ok: false,
        error: "INSUFFICIENT_WALLET",
        message: `Insufficient balance ($${wallet.balance.toFixed(2)}). This costs $${fee.toFixed(2)} — please top up.`,
      },
      { status: 402 },
    );
  }

  // deduct() writes a $0 "waived" ledger entry for free shops, so the
  // ledger stays consistent — call it unconditionally.
  await deduct(shop, fee, pkg ? `${pkg.label} package` : `Scheduled posts (${posts.length})`);

  // Everything after the charge must not leave the merchant paying for
  // nothing: any DB failure below triggers a refund.
  try {
    return await approveTransaction();
  } catch (e) {
    if (!isFreeShop(shop)) {
      const { refund } = await import("../lib/wallet.server");
      await refund(shop, fee, `Refund: schedule approve failed after charge`);
    }
    throw e;
  }

  async function approveTransaction() {
  // Create package record if applicable.
  let packageRecord = null;
  if (pkg) {
    const now = new Date();
    try {
      packageRecord = await prisma.schedulePackage.create({
        data: {
          shop,
          packageId: pkg.id,
          totalPosts: pkg.posts,
          usedPosts: posts.length,
          feeCharged: isFreeShop(shop) ? 0 : fee,
          status: "active",
          startsAt: now,
          endsAt: new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000),
          idempotencyKey,
        },
      });
    } catch {
      // Unique violation on idempotencyKey: a parallel request already
      // created it — return the existing one instead of double-charging.
      if (idempotencyKey) {
        const dup = await prisma.schedulePackage.findUnique({ where: { idempotencyKey } });
        if (dup && dup.shop === shop) {
          const count = await prisma.scheduledPost.count({ where: { schedulePackageId: dup.id } });
          // We already deducted above — refund the duplicate charge.
          if (!isFreeShop(shop)) {
            const { refund } = await import("../lib/wallet.server");
            await refund(shop, fee, `Refund: duplicate schedule approve (idempotency)`);
          }
          return json({ ok: true, count, packageId: dup.id, deduped: true });
        }
      }
      throw new Error("Could not create the package record.");
    }
  }

  // Auto-spread times: never allow two posts at the same date+time.
  // Checks both the new batch AND already-scheduled posts in the DB.
  // If a slot is taken, push forward in 30-min steps until free.
  const existingTimes = await prisma.scheduledPost.findMany({
    where: { shop, status: "scheduled", scheduledAt: { not: null } },
    select: { scheduledAt: true },
  });
  const usedSlots = new Set<string>(
    existingTimes.map((e) => e.scheduledAt!.toISOString().slice(0, 16)),
  );
  const spreadPosts = posts.map((p) => {
    let [h, m] = p.time.split(":").map(Number);
    let dateStr = p.date;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const key = `${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (!usedSlots.has(key)) {
        usedSlots.add(key);
        return { ...p, date: dateStr, time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
      }
      m += 30;
      if (m >= 60) {
        m -= 60;
        h += 1;
      }
      if (h >= 24) {
        // Roll to next day at 09:00
        const d = new Date(`${dateStr}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        dateStr = d.toISOString().slice(0, 10);
        h = 9;
        m = 0;
      }
    }
  });

  // Create scheduled posts at the chosen date+time (multiple per date allowed).
  const created = await prisma.$transaction(
    spreadPosts.map((p) =>
      prisma.scheduledPost.create({
        data: {
          shop,
          socialAccountId: accountId,
          content: p.content,
          mediaUrls: "[]",
          mediaType: "post",
          platforms: '["facebook"]',
          scheduledAt: new Date(`${p.date}T${p.time}:00Z`),
          status: "scheduled",
          schedulePackageId: packageRecord?.id ?? null,
        },
      }),
    ),
  );

  logActivity({
    shop,
    action: "schedule_package_approved",
    detail: `${pkg ? pkg.label : "Custom"}: ${created.length} posts scheduled, $${fee.toFixed(2)}`,
    feeCharged: isFreeShop(shop) ? 0 : fee,
  });

  return json({ ok: true, count: created.length, packageId: packageRecord?.id ?? null });
  } // end approveTransaction
};
