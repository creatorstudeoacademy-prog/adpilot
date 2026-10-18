import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { getWallet, normalizeShopDomain } from "../lib/wallet.server";
import prisma from "../db.server";

/**
 * POST /api/admin/add-balance (JSON: { amount })
 *
 * Admin-only: adds test balance to the wallet. For dev/testing only.
 * POST-only: a GET must never mutate wallet state.
 */
async function addBalance(request: Request, shop: string, amount: number) {
  // Only allow on free/dev shops or the admin shop (case-insensitive match).
  const freeShops = (process.env.FREE_SHOP_DOMAINS ?? "")
    .split(",")
    .map((s) => normalizeShopDomain(s));
  const adminShop = normalizeShopDomain(process.env.ADMIN_SHOP_DOMAIN ?? "");
  const normalizedShop = normalizeShopDomain(shop);
  if (!freeShops.includes(normalizedShop) && normalizedShop !== adminShop) {
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

export const loader = async ({}: LoaderFunctionArgs) => {
  return json(
    { ok: false, error: "Use POST with a JSON body { amount }." },
    { status: 405 },
  );
};
