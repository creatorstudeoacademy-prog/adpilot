import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const ADMIN_SHOP = process.env.ADMIN_SHOP_DOMAIN ?? "";

/**
 * POST /api/admin/create-coupon — admin only.
 * Body: { code, bonusPercent, fixedBonus, daysValid }
 * Creates a custom coupon code. fixedBonus (USD) overrides bonusPercent when set.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!ADMIN_SHOP || session.shop !== ADMIN_SHOP) {
    return json({ ok: false, error: "Admin only." }, { status: 403 });
  }

  let body: { code?: unknown; bonusPercent?: unknown; fixedBonus?: unknown; daysValid?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const code = String(body.code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const bonusPercent = Math.max(1, Math.min(100, Math.floor(Number(body.bonusPercent) || 10)));
  const fixedRaw = Number(body.fixedBonus);
  const fixedBonus = fixedRaw > 0 ? Math.min(1000, Math.round(fixedRaw * 100) / 100) : null;
  const daysValid = Math.max(1, Math.min(365, Math.floor(Number(body.daysValid) || 30)));

  if (!code || code.length < 4) {
    return json({ ok: false, error: "Code must be at least 4 characters (A-Z, 0-9)." }, { status: 400 });
  }

  const existing = await prisma.coupon.findUnique({ where: { code } });
  if (existing) {
    return json({ ok: false, error: "This code already exists." }, { status: 400 });
  }

  const coupon = await prisma.coupon.create({
    data: {
      code,
      bonusPercent,
      fixedBonus,
      expiresAt: new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000),
      active: true,
    },
  });

  return json({
    ok: true,
    coupon: {
      code: coupon.code,
      bonusPercent: coupon.bonusPercent,
      fixedBonus: coupon.fixedBonus,
      expiresAt: coupon.expiresAt.toISOString(),
    },
  });
};
