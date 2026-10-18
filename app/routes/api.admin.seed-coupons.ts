import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const ADMIN_SHOP = process.env.ADMIN_SHOP_DOMAIN ?? "";

/** Default coupon codes seeded once. */
const SEED_COUPONS = [
  { code: "WELCOME10", bonusPercent: 10, days: 30 },
  { code: "LAUNCH15", bonusPercent: 15, days: 60 },
  { code: "BOOST10", bonusPercent: 10, days: 90 },
  { code: "GROW20", bonusPercent: 20, days: 14 },
  { code: "ADS10", bonusPercent: 10, days: 45 },
];

/**
 * POST /api/admin/seed-coupons — admin only, seeds default coupon codes once.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!ADMIN_SHOP || session.shop !== ADMIN_SHOP) {
    return json({ ok: false, error: "Admin only." }, { status: 403 });
  }

  const now = new Date();
  let created = 0;
  for (const c of SEED_COUPONS) {
    const existing = await prisma.coupon.findUnique({ where: { code: c.code } });
    if (!existing) {
      await prisma.coupon.create({
        data: {
          code: c.code,
          bonusPercent: c.bonusPercent,
          expiresAt: new Date(now.getTime() + c.days * 24 * 60 * 60 * 1000),
          active: true,
        },
      });
      created++;
    }
  }
  return json({ ok: true, created });
};
