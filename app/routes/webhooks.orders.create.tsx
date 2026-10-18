import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { decryptToken } from "../lib/token-vault.server";
import { sendCAPIEvent } from "../lib/meta-ads.server";

interface ShopifyOrderWebhook {
  id: number;
  name: string;
  test: boolean;
  currency: string;
  total_price: string;
  referring_site?: string | null;
  landing_site?: string | null;
  customer?: { email?: string | null; phone?: string | null } | null;
  line_items: Array<{ variant_id?: number | null; product_id?: number | null; quantity: number }>;
}

/**
 * POST /webhooks/orders/create
 * Every REAL Shopify order fires a server-side Purchase to Meta via the
 * Conversions API — the "pure signal" Meta optimizes on. The browser pixel
 * fires the same event with the same event_id, so Meta dedupes them.
 * Test orders are skipped.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  // eslint-disable-next-line no-console
  console.log(`Received ${topic} webhook for ${shop}`);

  let order: ShopifyOrderWebhook;
  try {
    order = (await request.json()) as ShopifyOrderWebhook;
  } catch {
    return new Response();
  }

  // Never send fake signals: skip test orders.
  if (order.test) {
    // eslint-disable-next-line no-console
    console.log(`[capi] skipping test order ${order.name}`);
    return new Response();
  }

  // Find the pixel to report to (prefer the ad account that has one).
  const adAccounts = await db.adAccount.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
  const adAccount = adAccounts.find((a) => a.pixelId?.trim()) ?? adAccounts[0] ?? null;
  const pixelId = adAccount?.pixelId?.trim();
  const tokenRow = await db.metaUserToken.findUnique({ where: { shop } });
  if (!pixelId || !tokenRow) {
    // eslint-disable-next-line no-console
    console.log(`[capi] no pixel/token for ${shop}, skipping order ${order.name}`);
    return new Response();
  }

  const accessToken = decryptToken(tokenRow.accessToken);
  const eventId = `shopify_${order.id}`;
  const value = parseFloat(order.total_price || "0") || 0;
  const contentIds = order.line_items
    .map((li) => (li.variant_id ? `shopify_${li.variant_id}` : null))
    .filter((x): x is string => !!x);

  const result = await sendCAPIEvent(pixelId, accessToken, {
    eventName: "Purchase",
    eventId,
    eventSourceUrl: order.landing_site ?? `https://${shop}`,
    customData: {
      currency: order.currency,
      value: Math.round(value * 100) / 100,
      content_ids: contentIds,
      content_type: "product",
      order_id: String(order.id),
    },
  });

  // Log to our own event store so the Data Doctor can verify purity.
  if (result.eventsReceived > 0) {
    await db.pixelEvent.create({
      data: {
        shop,
        pixelId,
        eventName: "Purchase",
        source: "server",
        url: order.landing_site ?? `https://${shop}`,
        value: Math.round(value * 100) / 100,
        currency: order.currency,
        contentIds: contentIds.join(",") || null,
        eventId,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[capi] Purchase sent for order ${order.name} (${order.currency} ${value})`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[capi] failed for order ${order.name}: ${result.error}`);
  }

  return new Response();
};
