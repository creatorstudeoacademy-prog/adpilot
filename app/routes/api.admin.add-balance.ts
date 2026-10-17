import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { getWallet } from "../lib/wallet.server";
import prisma from "../db.server";

/**
 * POST /api/admin/add-balance (JSON: { amount })
 * GET  /api/admin/add-balance?amount=50
 *
 * Admin-only: adds test balance to the wallet. For dev/testing only.
 */
async function addBalance(request: Request, shop: string, amount: number) {
  // Only allow on free/dev shops or the admin shop.
  const freeShops = (process.env.FREE_SHOP_DOMAINS ?? "").split(",").map((s) => s.trim());
  const adminShop = (process.env.ADMIN_SHOP_DOMAIN ?? "").trim();
  if (!freeShops.includes(shop) && shop !== adminShop) {
    return json({ ok: false, error: "Not allowed." }, { status: 403 });
  }
  if (!amount || amount <= 0 || amount > 1000) {
    return json({ ok: false, error: "Amount must be 1-1000." }, { status: 400 });
  }

  const wallet = await prisma.wallet.upsert({
    where: { shop },
    create: { shop, balance: amount },
    update: { balance: { increment: amount } },
  });
  await prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      amount,
      type: "topup",
      description: "Admin test balance",
    },
  });

  const updated = await prisma.wallet.findUnique({ where: { shop } });
  return json({ ok: true, balance: updated?.balance ?? amount });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  let body: { amount?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  return addBalance(request, session.shop, Number(body.amount ?? 0));
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  return addBalance(request, session.shop, Number(url.searchParams.get("amount") ?? 0));
};
