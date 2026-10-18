import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory GDPR webhook: erase all data for a shop (48h after uninstall).
 *
 * Deletes every shop-scoped record: OAuth sessions, Meta tokens, social
 * accounts, scheduled posts, ad accounts, campaigns, audiences, funnel
 * groups, wallet + ledger, activity log, AI agents/providers, schedule
 * packages, lifetime packages, coupon redemptions/requests, reviews.
 * Global Coupon rows are shared and are NOT deleted.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  // eslint-disable-next-line no-console
  console.log(
    `Received ${topic} webhook for ${shop} (shop_id ${payload.shop_id ?? "unknown"}) — erasing all shop data.`,
  );

  // Children first (respect FK constraints; most also cascade).
  await db.scheduledPost.deleteMany({ where: { shop } });
  await db.campaign.deleteMany({ where: { shop } });
  await db.audience.deleteMany({ where: { shop } });
  await db.walletTransaction.deleteMany({ where: { shop } });
  await db.couponRedemption.deleteMany({ where: { shop } });
  await db.couponRequest.deleteMany({ where: { shop } });
  await db.shopCoupon.deleteMany({ where: { shop } });

  // Parents / shop-scoped singletons.
  await db.socialAccount.deleteMany({ where: { shop } });
  await db.adAccount.deleteMany({ where: { shop } });
  await db.funnelGroup.deleteMany({ where: { shop } });
  await db.wallet.deleteMany({ where: { shop } });
  await db.metaUserToken.deleteMany({ where: { shop } });
  await db.session.deleteMany({ where: { shop } });
  await db.activityLog.deleteMany({ where: { shop } });
  await db.aiAgent.deleteMany({ where: { shop } });
  await db.aiProvider.deleteMany({ where: { shop } });
  await db.schedulePackage.deleteMany({ where: { shop } });
  await db.lifetimePackage.deleteMany({ where: { shop } });
  await db.review.deleteMany({ where: { shop } });

  return new Response();
};
