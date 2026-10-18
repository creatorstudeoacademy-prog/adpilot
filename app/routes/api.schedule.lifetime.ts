import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deduct, getWallet, isFreeShop } from "../lib/wallet.server";
import {
  LIFETIME_BILLING_DAYS,
  LIFETIME_MAX_POSTS_PER_DAY,
  LIFETIME_PACKS,
  lifetimeFee,
} from "../lib/pricing";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/schedule/lifetime
 * Body: { action: "activate", postsPerDay } | { action: "cancel" } | { action: "toggle-renew" }
 *
 * - activate: charges 90 days upfront (10% off), locks for 3 months, no cancel before endsAt.
 * - cancel: only allowed after the 3-month lock (sets autoRenew=false, status stays active till endsAt).
 * - toggle-renew: flips autoRenew.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { action?: unknown; postsPerDay?: unknown; packId?: unknown } = {};
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
    const rec = await prisma.lifetimePackage.create({
      data: {
        shop,
        postsPerDay,
        feeCharged: isFreeShop(shop) ? 0 : fee,
        status: "active",
        autoRenew: true,
        startsAt: now,
        endsAt: new Date(now.getTime() + LIFETIME_BILLING_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    logActivity({
      shop,
      action: "lifetime_activated",
      detail: `${postsPerDay} posts/day × 3 months, $${fee.toFixed(2)}`,
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

  return json({ ok: false, error: "BAD_ACTION", message: "Unknown action." }, { status: 400 });
};
