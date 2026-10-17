import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { getWallet } from "../lib/wallet.server";
import prisma from "../db.server";

/**
 * POST /api/admin/add-balance
 * Body (JSON): { amount }
 *
 * Admin-only: adds test balance to the wallet. For dev/testing only.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Only allow on free/dev shops.
  const freeShops = (process.env.FREE_SHOP_DOMAINS ?? "").split(",").map((s) => s.trim());
  if (!freeShops.includes(shop)) {
    return json({ ok: false, error: "Not allowed." }, { status: 403 });
  }

  let body: { amount?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const amount = Number(body.amount ?? 0);
  if (!amount || amount <= 0 || amount > 1000) {
    return json({ ok: false, error: "Amount must be 1-1000." }, { status: 400 });
  }

  const wallet = await getWallet(shop);
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: wallet.balance + amount },
  });
  await prisma.walletLedger.create({
    data: {
      walletId: wallet.id,
      amount,
      type: "topup",
      description: "Admin test balance",
    },
  });

  const updated = await getWallet(shop);
  return json({ ok: true, balance: updated.balance });
};
