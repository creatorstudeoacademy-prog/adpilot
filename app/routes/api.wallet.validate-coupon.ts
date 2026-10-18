import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * POST /api/wallet/validate-coupon
 * Body: { code }
 * Returns coupon validity: not expired, still active, not already used by this shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { code?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code) {
    return json({ ok: false, error: "Enter a coupon code." }, { status: 400 });
  }

  const coupon = await prisma.coupon.findUnique({ where: { code } });
  if (!coupon || !coupon.active) {
    return json({ ok: false, error: "Invalid coupon code." }, { status: 400 });
  }
  // Edge case: expiresAt is compared in server UTC. A coupon created with
  // "30 days" validity expires exactly 30×24h after creation in UTC, which
  // can feel up to a day early/late for merchants in far timezones. Accepted
  // as-is: coupon windows are day-granular and generous.
  if (coupon.expiresAt < new Date()) {
    return json({ ok: false, error: "This coupon has expired." }, { status: 400 });
  }
  const used = await prisma.couponRedemption.findUnique({
    where: { couponId_shop: { couponId: coupon.id, shop } },
  });
  if (used) {
    return json({ ok: false, error: "You have already used this coupon." }, { status: 400 });
  }

  return json({
    ok: true,
    bonusPercent: coupon.bonusPercent,
    fixedBonus: coupon.fixedBonus,
    expiresAt: coupon.expiresAt.toISOString(),
  });
};
