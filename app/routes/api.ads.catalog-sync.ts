import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken } from "../lib/token-vault.server";

const GRAPH_VERSION = "v21.0";

interface ShopifyVariant {
  id: string;
  title: string;
  price: string;
  sku?: string | null;
  image?: { url: string } | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  vendor?: string | null;
  featuredImage?: { url: string } | null;
  priceRangeV2?: { minVariantPrice?: { amount: string; currencyCode: string } | null } | null;
  variants: { edges: Array<{ node: ShopifyVariant }> };
}

async function fetchShopifyProducts(admin: any, shopDomain: string): Promise<ShopifyProduct[]> {
  const res = await admin.graphql(
    `#graphql
    query {
      products(first: 50, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            title
            handle
            description(truncateAt: 500)
            vendor
            featuredImage { url }
            priceRangeV2 { minVariantPrice { amount currencyCode } }
            variants(first: 20) {
              edges {
                node {
                  id
                  title
                  price
                  sku
                  image { url }
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    }`,
  );
  const data = (await res.json()) as any;
  return (data.data?.products?.edges ?? []).map((e: any) => e.node as ShopifyProduct);
}

function retailerId(variantGid: string): string {
  const num = variantGid.split("/").pop() ?? variantGid;
  return `shopify_${num}`;
}

/**
 * POST /api/ads/catalog-sync
 * Body (JSON): { action: "preview" | "sync" }
 *
 * Syncs the Shopify store's products into the active Meta product catalog
 * via items_batch. retailer_id = shopify_<variantId> so Meta Pixel events
 * (ViewContent/AddToCart/Purchase with the same content_ids) match catalog
 * items — this is the pixel <-> catalog integration.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { action?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const act = String(body.action ?? "");

  const catalog = await prisma.productCatalog.findFirst({ where: { shop, isActive: true } });
  if (!catalog) {
    return json(
      { ok: false, message: "Connect a product catalog first (Accounts page)." },
      { status: 400 },
    );
  }
  const tokenRecord = await prisma.metaUserToken.findFirst({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  if (!tokenRecord) {
    return json({ ok: false, message: "Connect Facebook first." }, { status: 400 });
  }
  const token = decryptToken(tokenRecord.accessToken);

  let products: ShopifyProduct[];
  try {
    products = await fetchShopifyProducts(admin, shop);
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Could not read store products." },
      { status: 500 },
    );
  }
  if (products.length === 0) {
    return json({ ok: false, message: "No products found in your store." }, { status: 400 });
  }

  if (act === "preview") {
    const variantCount = products.reduce((n, p) => n + p.variants.edges.length, 0);
    return json({
      ok: true,
      productCount: products.length,
      variantCount,
      catalogName: catalog.name,
      sample: products.slice(0, 5).map((p) => ({
        title: p.title,
        price: p.priceRangeV2?.minVariantPrice
          ? `${p.priceRangeV2.minVariantPrice.amount} ${p.priceRangeV2.minVariantPrice.currencyCode}`
          : "n/a",
        variants: p.variants.edges.length,
      })),
    });
  }

  if (act !== "sync") {
    return json({ ok: false, message: "Unknown action." }, { status: 400 });
  }

  // Existing retailer_ids in the catalog (to decide create vs update).
  const existing = new Set<string>();
  try {
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({
        fields: "retailer_id",
        limit: "1000",
        access_token: token,
        ...(after ? { after } : {}),
      });
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${catalog.catalogId}/products?${params}`,
      );
      const data = (await res.json()) as {
        data?: Array<{ retailer_id?: string }>;
        paging?: { cursors?: { after?: string }; next?: string };
      };
      for (const item of data.data ?? []) {
        if (item.retailer_id) existing.add(item.retailer_id);
      }
      after = data.paging?.cursors?.after ?? null;
      if (!data.paging?.next) break;
    }
  } catch {
    // best-effort: fall back to create (duplicates will report per-item errors)
  }

  const shopDomain = `https://${shop}`;
  const requests: Array<{ method: string; data: Record<string, unknown> }> = [];
  for (const p of products) {
    const currency = p.priceRangeV2?.minVariantPrice?.currencyCode ?? "USD";
    for (const { node: v } of p.variants.edges) {
      const rid = retailerId(v.id);
      const color = v.selectedOptions.find((o) => o.name.toLowerCase() === "color")?.value;
      const size = v.selectedOptions.find((o) => o.name.toLowerCase() === "size")?.value;
      requests.push({
        method: existing.has(rid) ? "update" : "create",
        data: {
          retailer_id: rid,
          name: v.title === "Default Title" ? p.title : `${p.title} — ${v.title}`,
          description: (p.description || p.title).slice(0, 5000),
          price: `${parseFloat(v.price).toFixed(2)} ${currency}`,
          image_url: v.image?.url ?? p.featuredImage?.url ?? "",
          link: `${shopDomain}/products/${p.handle}?variant=${rid.replace("shopify_", "")}`,
          availability: "in stock",
          condition: "new",
          brand: (p.vendor || shopDomain).slice(0, 100),
          ...(color ? { color } : {}),
          ...(size ? { size } : {}),
        },
      });
    }
  }

  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  // Meta allows large batches; 50 per request is safe.
  for (let i = 0; i < requests.length; i += 50) {
    const chunk = requests.slice(i, i + 50);
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${catalog.catalogId}/items_batch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            access_token: token,
            item_type: "PRODUCT_ITEM",
            requests: chunk,
          }),
        },
      );
      const data = (await res.json()) as {
        error?: { message?: string };
        responses?: Array<{ method?: string; retailer_id?: string; error?: { message?: string } }>;
      };
      if (data.error) throw new Error(data.error.message ?? "Batch failed.");
      for (const r of data.responses ?? []) {
        if (r.error) {
          if (errors.length < 5) errors.push(`${r.retailer_id ?? "?"}: ${r.error.message}`);
        } else if (r.method === "create") {
          created++;
        } else {
          updated++;
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Batch request failed.");
    }
  }

  await prisma.activityLog.create({
    data: {
      shop,
      action: "catalog_sync",
      detail: `Synced ${created + updated} items to catalog ${catalog.name} (${created} new, ${updated} updated)`,
    },
  });

  return json({
    ok: true,
    created,
    updated,
    total: requests.length,
    errors: errors.slice(0, 5),
    message:
      `Synced ${created + updated} of ${requests.length} items to "${catalog.name}" ` +
      `(${created} new, ${updated} updated).` +
      (errors.length > 0 ? ` ${errors.length} item(s) had errors.` : ""),
  });
};
