import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GET /api/ads/catalog-products?catalogId=...&type=products|sets
 *
 * Returns products (for the product picker / post-from-catalog) or
 * product sets (for catalog sales ads) of a connected catalog.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const catalogParam = url.searchParams.get("catalogId")?.trim() ?? "";
  const type = url.searchParams.get("type") ?? "products";
  let connected;
  if (catalogParam === "active") {
    connected = await prisma.productCatalog.findFirst({ where: { shop, isActive: true } });
  } else {
    if (!catalogParam) {
      return json({ ok: false, message: "catalogId is required." }, { status: 400 });
    }
    connected = await prisma.productCatalog.findFirst({ where: { shop, catalogId: catalogParam } });
  }
  if (!connected) {
    return json({ ok: false, message: "No active catalog connected." }, { status: 404 });
  }
  const catalogId = connected.catalogId;
  const tokenRecord = await prisma.metaUserToken.findFirst({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  if (!tokenRecord) {
    return json({ ok: false, message: "Connect Facebook first." }, { status: 400 });
  }

  try {
    const { listCatalogProducts, listProductSets } = await import("../lib/meta-ads.server");
    if (type === "sets") {
      const sets = await listProductSets(catalogId, tokenRecord.accessToken);
      return json({ ok: true, sets });
    }
    const products = await listCatalogProducts(catalogId, tokenRecord.accessToken);
    return json({ ok: true, products });
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Could not load catalog data." },
      { status: 500 },
    );
  }
};
