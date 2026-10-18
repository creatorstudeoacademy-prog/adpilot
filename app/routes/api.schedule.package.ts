import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deduct, getWallet, isFreeShop } from "../lib/wallet.server";
import { SCHEDULE_PACKAGES } from "../lib/pricing";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/schedule/package — buy an auto-schedule package.
 * Body (JSON): { packageId: "7d" | "15d" | "30d" }
 * Deducts the package fee from the wallet, creates a SchedulePackage record.
 * Returns { ok, package } or { ok:false, error, message }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { packageId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const pkg = SCHEDULE_PACKAGES.find((p) => p.id === String(body.packageId ?? ""));
  if (!pkg) {
    return json(
      { ok: false, error: "INVALID_PACKAGE", message: "Unknown package." },
      { status: 400 },
    );
  }

  // One active package at a time per shop.
  const existing = await prisma.schedulePackage.findFirst({
    where: { shop, status: "active" },
  });
  if (existing) {
    return json(
      {
        ok: false,
        error: "ALREADY_ACTIVE",
        message: "You already have an active package. It must expire first.",
      },
      { status: 400 },
    );
  }

  // Wallet check + deduct (free shops skip).
  const wallet = await getWallet(shop);
  if (!isFreeShop(shop) && wallet.balance < pkg.fee) {
    return json(
      {
        ok: false,
        error: "INSUFFICIENT_WALLET",
        message: `Insufficient balance ($${wallet.balance.toFixed(2)}). This package costs $${pkg.fee.toFixed(2)} — please top up.`,
      },
      { status: 402 },
    );
  }

  if (!isFreeShop(shop)) {
    await deduct(shop, pkg.fee, `${pkg.label} package`);
  }

  const now = new Date();
  const record = await prisma.schedulePackage.create({
    data: {
      shop,
      packageId: pkg.id,
      totalPosts: pkg.posts,
      usedPosts: 0,
      feeCharged: isFreeShop(shop) ? 0 : pkg.fee,
      status: "active",
      startsAt: now,
      endsAt: new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000),
    },
  });

  logActivity({
    shop,
    action: "schedule_package",
    detail: `${pkg.label} activated (${pkg.posts} posts, $${pkg.fee.toFixed(2)})`,
    feeCharged: isFreeShop(shop) ? 0 : pkg.fee,
  });

  return json({
    ok: true,
    package: {
      id: record.id,
      label: pkg.label,
      totalPosts: record.totalPosts,
      endsAt: record.endsAt.toISOString(),
    },
  });
};
