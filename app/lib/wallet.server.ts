/**
 * Server-only wallet helpers for AdPilot ad spend.
 * The wallet holds prepaid credit merchants top up via Shopify one-time charges.
 * Ad publishes deduct from the wallet before hitting the Meta API.
 */

import prisma from "../db.server";
import { OBJECTIVE_FEES } from "./pricing";

export { OBJECTIVE_FEES };

/**
 * Owner's own stores use the app completely free — no wallet charges ever.
 * FREE_SHOP_DOMAINS: comma-separated myshopify domains, e.g.
 * "creator-studio-store.myshopify.com,other-store.myshopify.com".
 * Unset or empty = nobody is free (default: every merchant pays normally).
 */
function getFreeShopDomains(): string[] {
  const raw = process.env.FREE_SHOP_DOMAINS ?? "";
  return raw
    .split(",")
    .map((d) => normalizeShopDomain(d))
    .filter(Boolean);
}

export function normalizeShopDomain(shop: string): string {
  return (shop ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** True when this shop is on the owner's free list (never charged, never blocked). */
export function isFreeShop(shop: string): boolean {
  const normalized = normalizeShopDomain(shop);
  if (!normalized) return false;
  return getFreeShopDomains().includes(normalized);
}

export async function getWallet(shop: string) {
  let wallet = await prisma.wallet.findUnique({ where: { shop } });
  if (!wallet) {
    wallet = await prisma.wallet.create({ data: { shop, balance: 0 } });
  }
  return wallet;
}

/** Credit the wallet (after a successful Shopify one-time charge). Idempotent per metaRef. */
export async function topup(
  shop: string,
  amount: number,
  description?: string,
  metaRef?: string,
  bonus: number = 0,
) {
  if (amount <= 0) throw new Error("Topup amount must be positive.");
  const total = amount + bonus;
  const wallet = await getWallet(shop);
  // Belt-and-suspenders: skip if this charge was already credited.
  if (metaRef) {
    const existing = await prisma.walletTransaction.findFirst({
      where: { shop, type: "topup", metaRef },
    });
    if (existing) return wallet;
  }
  const updated = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: { increment: total } },
  });
  await prisma.walletTransaction.create({
    data: {
      shop,
      walletId: wallet.id,
      amount: total,
      type: "topup",
      description:
        description ??
        (bonus > 0
          ? `Wallet topup $${amount.toFixed(2)} + $${bonus.toFixed(2)} bonus`
          : `Wallet topup $${amount.toFixed(2)}`),
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
  if (isFreeShop(shop)) {
    // Owner's own store: bypass — no deduction, no balance requirement.
    // Logged distinctly with amount 0 so the ledger stays honest.
    await prisma.walletTransaction.create({
      data: {
        shop,
        walletId: wallet.id,
        amount: 0,
        type: "ad_spend",
        description: `free-shop (waived $${amount.toFixed(2)}): ${description}`,
        metaRef,
      },
    });
    return wallet;
  }
  // Atomic check-and-decrement: prevents concurrent deducts from overdrawing.
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (updated.count === 0) {
      throw new Error(
        `Insufficient wallet balance ($${wallet.balance.toFixed(2)}). Please top up at least $${amount.toFixed(2)}.`,
      );
    }
    await tx.walletTransaction.create({
      data: {
        shop,
        walletId: wallet.id,
        amount: -amount,
        type: "ad_spend",
        description,
        metaRef,
      },
    });
    return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  });
  return result;
}

/** Refund a previous deduction (e.g. when Meta publish fails after deduct). */
export async function refund(shop: string, amount: number, description: string, metaRef?: string) {
  if (amount <= 0) throw new Error("Refund amount must be positive.");
  const wallet = await getWallet(shop);
  if (isFreeShop(shop)) {
    // Nothing was ever charged for a free shop — refunding would create
    // phantom credit, so this is a no-op.
    return wallet;
  }
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
