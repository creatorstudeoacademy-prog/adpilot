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

  // NOTE: AdPilot stores all data (social accounts, scheduled posts) in its
  // own database. Clean up the shop's data on uninstall.
  await db.scheduledPost.deleteMany({ where: { shop } });
  await db.socialAccount.deleteMany({ where: { shop } });

  return new Response();
};
