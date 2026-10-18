import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const ADMIN_SHOP = process.env.ADMIN_SHOP_DOMAIN ?? "";

function requireAdmin(shop: string) {
  if (!ADMIN_SHOP || shop !== ADMIN_SHOP) {
    throw new Response("Not found", { status: 404 });
  }
}

/**
 * GET /api/admin/coupon-requests — pending requests + recent shops.
 * POST /api/admin/coupon-requests — { action: "send", requestId, couponId } |
 *   { action: "send-to-shop", shop, couponId } | { action: "reject", requestId }
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  requireAdmin(session.shop);

  const requests = await prisma.couponRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Recent shops (from wallets) that don't have a coupon yet.
  const wallets = await prisma.wallet.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { shop: true, createdAt: true },
  });
  const sentShops = new Set(
    (await prisma.shopCoupon.findMany({ select: { shop: true } })).map((s) => s.shop),
  );
  const newShops = wallets
    .filter((w) => !sentShops.has(w.shop) && w.shop !== session.shop)
    .slice(0, 20);

  const coupons = await prisma.coupon.findMany({
    where: { active: true, expiresAt: { gte: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, code: true, bonusPercent: true },
  });

  return json({
    requests: requests.map((r) => ({
      id: r.id,
      shop: r.shop,
      message: r.message,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    newShops: newShops.map((w) => ({
      shop: w.shop,
      since: w.createdAt.toISOString(),
    })),
    coupons,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  requireAdmin(session.shop);

  let body: { action?: unknown; requestId?: unknown; shop?: unknown; couponId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const act = String(body.action ?? "");

  if (act === "reject") {
    await prisma.couponRequest.update({
      where: { id: String(body.requestId) },
      data: { status: "rejected" },
    });
    return json({ ok: true });
  }

  if (act === "send" || act === "send-to-shop") {
    const code = String(body.couponCode ?? body.couponId ?? "").trim().toUpperCase();
    const coupon = await prisma.coupon.findUnique({ where: { code } });
    if (!coupon || !coupon.active || coupon.expiresAt < new Date()) {
      return json({ ok: false, error: "Coupon not available." }, { status: 400 });
    }

    let shop = String(body.shop ?? "");
    if (act === "send") {
      const req = await prisma.couponRequest.findUnique({
        where: { id: String(body.requestId) },
      });
      if (!req) return json({ ok: false, error: "Request not found." }, { status: 400 });
      shop = req.shop;
      await prisma.couponRequest.update({
        where: { id: req.id },
        data: { status: "sent" },
      });
    }
    if (!shop) return json({ ok: false, error: "No shop specified." }, { status: 400 });

    await prisma.shopCoupon.upsert({
      where: { couponId_shop: { couponId: coupon.id, shop } },
      update: {},
      create: { couponId: coupon.id, shop },
    });
    return json({ ok: true, shop, code: coupon.code });
  }

  return json({ ok: false, error: "Unknown action." }, { status: 400 });
};
