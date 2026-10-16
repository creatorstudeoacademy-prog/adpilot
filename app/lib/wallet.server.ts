/**
 * Server-only wallet helpers for AdPilot ad spend.
 * The wallet holds prepaid credit merchants top up via Shopify one-time charges.
 * Ad publishes deduct from the wallet before hitting the Meta API.
 */

import prisma from "../db.server";

export async function getWallet(shop: string) {
  let wallet = await prisma.wallet.findUnique({ where: { shop } });
  if (!wallet) {
    wallet = await prisma.wallet.create({ data: { shop, balance: 0 } });
  }
  return wallet;
}

/** Credit the wallet (after a successful Shopify one-time charge). */
export async function topup(shop: string, amount: number, description?: string, metaRef?: string) {
  if (amount <= 0) throw new Error("Topup amount must be positive.");
  const wallet = await getWallet(shop);
  const updated = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: { increment: amount } },
  });
  await prisma.walletTransaction.create({
    data: {
      shop,
      walletId: wallet.id,
      amount,
      type: "topup",
      description: description ?? `Wallet topup $${amount.toFixed(2)}`,
      metaRef,
    },
  });
  return updated;
}

/**
 * Deduct from the wallet for ad spend.
 * Throws if the balance is insufficient — callers should redirect to /app/wallet.
 */
export async function deduct(shop: string, amount: number, description: string, metaRef?: string) {
  if (amount <= 0) throw new Error("Deduction amount must be positive.");
  const wallet = await getWallet(shop);
  if (wallet.balance < amount) {
    throw new Error(
      `Insufficient wallet balance ($${wallet.balance.toFixed(2)}). Please top up at least $${amount.toFixed(2)}.`,
    );
  }
  const updated = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: { decrement: amount } },
  });
  await prisma.walletTransaction.create({
    data: {
      shop,
      walletId: wallet.id,
      amount: -amount,
      type: "ad_spend",
      description,
      metaRef,
    },
  });
  return updated;
}

/** Refund a previous deduction (e.g. when Meta publish fails after deduct). */
export async function refund(shop: string, amount: number, description: string, metaRef?: string) {
  const wallet = await getWallet(shop);
  const updated = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: { increment: amount } },
  });
  await prisma.walletTransaction.create({
    data: {
      shop,
      walletId: wallet.id,
      amount,
      type: "refund",
      description,
      metaRef,
    },
  });
  return updated;
}

export async function getTransactions(shop: string, limit = 25) {
  return prisma.walletTransaction.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
