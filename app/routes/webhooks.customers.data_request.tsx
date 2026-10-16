import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";

/**
 * Mandatory GDPR webhook: a customer requested their data.
 *
 * This app stores NO customer PII — only shop-level bar configuration
 * (goal, messages, colors) in shop metafields and OAuth sessions in its own
 * database. There is nothing customer-specific to return, so we acknowledge
 * receipt immediately, as Shopify requires.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  // eslint-disable-next-line no-console
  console.log(
    `Received ${topic} webhook for ${shop} (customer ${payload.customer?.id ?? "unknown"}) — no customer data stored, nothing to return.`,
  );

  return new Response();
};
