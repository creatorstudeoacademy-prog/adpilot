import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory GDPR webhook: erase all data for a shop (48h after uninstall).
 *
 * This app stores:
 *  - OAuth sessions in its own database  -> deleted below
 *  - Shop-level pixel configuration in shop metafields (namespace
 *    "pixelpro") -> shop-owned data; the merchant can delete it in
 *    the theme editor / admin. No customer PII is stored anywhere.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  // eslint-disable-next-line no-console
  console.log(
    `Received ${topic} webhook for ${shop} (shop_id ${payload.shop_id ?? "unknown"}) — deleting sessions.`,
  );

  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
