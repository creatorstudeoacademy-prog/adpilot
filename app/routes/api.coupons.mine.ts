import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GET /api/coupons/mine — coupons sent to this shop.
 * POST /api/coupons/request — request a coupon { message? }.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const mine = await prisma.shopCoupon.findMany({
    where: { shop },
    include: { coupon: true },
    orderBy: { sentAt: "desc" },
  });

  // Mark used ones.
  const usedIds = new Set(
    (
      await prisma.couponRedemption.findMany({
        where: { shop },
        select: { couponId: true },
      })
    ).map((r) => r.couponId),
  );

  return json({
    coupons: mine.map((s) => ({
      code: s.coupon.code,
      bonusPercent: s.coupon.bonusPercent,
      expiresAt: s.coupon.expiresAt.toISOString(),
      expired: s.coupon.expiresAt < new Date() || !s.coupon.active,
      used: usedIds.has(s.couponId),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { message?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const pending = await prisma.couponRequest.findFirst({
    where: { shop, status: "pending" },
  });
  if (pending) {
    return json({ ok: false, error: "You already have a pending request." }, { status: 400 });
  }

  await prisma.couponRequest.create({
    data: {
      shop,
      message: String(body.message ?? "").slice(0, 500),
      status: "pending",
    },
  });
  return json({ ok: true, message: "Request sent! We'll send you a coupon soon." });
};
