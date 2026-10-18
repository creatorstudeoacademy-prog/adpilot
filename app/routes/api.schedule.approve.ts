import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deduct, getWallet, isFreeShop } from "../lib/wallet.server";
import { SCHEDULE_PACKAGES, TEXT_POST_FEE } from "../lib/pricing";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/schedule/approve — approve AI-generated drafts: charge + schedule.
 * Body: { packageId, accountId, posts: [{ date: YYYY-MM-DD, content: string }] }
 * - Deducts package fee from wallet (or per-post fee if no package)
 * - Creates SchedulePackage record + ScheduledPost rows (status "scheduled")
 * Returns { ok, count } or { ok:false, error, message }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { packageId?: unknown; accountId?: unknown; posts?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const accountId = String(body.accountId ?? "").trim();
  const rawPosts = Array.isArray(body.posts) ? body.posts : [];
  const posts = rawPosts
    .filter(
      (p): p is { date: string; content: string } =>
        !!p && typeof p === "object" &&
        typeof (p as { date?: unknown }).date === "string" &&
        typeof (p as { content?: unknown }).content === "string" &&
        String((p as { content: string }).content).trim().length > 0,
    )
    .map((p) => ({
      date: String(p.date).slice(0, 10),
      content: String(p.content).trim().slice(0, 2000),
    }));

  if (!accountId || posts.length === 0) {
    return json(
      { ok: false, error: "MISSING_INPUT", message: "Select an account and add at least one post." },
      { status: 400 },
    );
  }

  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, shop },
  });
  if (!account) {
    return json({ ok: false, error: "BAD_ACCOUNT", message: "Account not found." }, { status: 400 });
  }

  const pkg = SCHEDULE_PACKAGES.find((p) => p.id === String(body.packageId ?? ""));
  // Fee: package fee if a valid package chosen, else per-post fee.
  const fee = pkg ? pkg.fee : posts.length * TEXT_POST_FEE;

  // One active package at a time.
  if (pkg) {
    const existing = await prisma.schedulePackage.findFirst({
      where: { shop, status: "active" },
    });
    if (existing) {
      return json(
        { ok: false, error: "ALREADY_ACTIVE", message: "You already have an active package." },
        { status: 400 },
      );
    }
  }

  const wallet = await getWallet(shop);
  if (!isFreeShop(shop) && wallet.balance < fee) {
    return json(
      {
        ok: false,
        error: "INSUFFICIENT_WALLET",
        message: `Insufficient balance ($${wallet.balance.toFixed(2)}). This costs $${fee.toFixed(2)} — please top up.`,
      },
      { status: 402 },
    );
  }

  if (!isFreeShop(shop)) {
    await deduct(shop, fee, pkg ? `${pkg.label} package` : `Scheduled posts (${posts.length})`);
  }

  // Create package record if applicable.
  let packageRecord = null;
  if (pkg) {
    const now = new Date();
    packageRecord = await prisma.schedulePackage.create({
      data: {
        shop,
        packageId: pkg.id,
        totalPosts: pkg.posts,
        usedPosts: posts.length,
        feeCharged: isFreeShop(shop) ? 0 : fee,
        status: "active",
        startsAt: now,
        endsAt: new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000),
      },
    });
  }

  // Create scheduled posts (9:00 AM UTC on each date).
  const created = await prisma.$transaction(
    posts.map((p) =>
      prisma.scheduledPost.create({
        data: {
          shop,
          socialAccountId: accountId,
          content: p.content,
          mediaUrls: "[]",
          mediaType: "post",
          platforms: '["facebook"]',
          scheduledAt: new Date(`${p.date}T09:00:00Z`),
          status: "scheduled",
        },
      }),
    ),
  );

  logActivity({
    shop,
    action: "schedule_package_approved",
    detail: `${pkg ? pkg.label : "Custom"}: ${created.length} posts scheduled, $${fee.toFixed(2)}`,
    feeCharged: isFreeShop(shop) ? 0 : fee,
  });

  return json({ ok: true, count: created.length, packageId: packageRecord?.id ?? null });
};
