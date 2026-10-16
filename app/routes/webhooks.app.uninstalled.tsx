import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  // eslint-disable-next-line no-console
  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already
  // been uninstalled. If this webhook already ran, the session may have been
  // deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // NOTE: the shop's pixel configuration lives in shop metafields
  // (namespace "pixelpro"). It cannot be removed here because the
  // API session is gone after uninstall. The metafield is tiny JSON and
  // harmless; it is overwritten on the next install.

  return new Response();
};
