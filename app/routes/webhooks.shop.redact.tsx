import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory GDPR webhook: erase all data for a shop (48h after uninstall).
 *
 * This app stores:
 *  - OAuth sessions in its own database  -> deleted below
 *  - Social accounts + scheduled posts in its own database -> no customer PII.
 *    Meta access tokens are shop-level credentials, deleted on app uninstall.
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
