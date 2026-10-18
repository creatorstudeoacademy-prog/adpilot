import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * POST /api/ads/catalog
 * Body (JSON): { action: "list" | "connect" | "set-active" | "disconnect" | "create", catalogId?, name? }
 *
 * - list: catalogs in the active Business Manager + connected/active flags.
 * - connect: connect a catalog (sets as active).
 * - set-active: switch the active catalog.
 * - disconnect: remove a connected catalog.
 * - create: create a new catalog under the active Business Manager, then connect it.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { action?: unknown; catalogId?: unknown; name?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const act = String(body.action ?? "");

  const tokenRecord = await prisma.metaUserToken.findFirst({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  if (!tokenRecord) {
    return json({ ok: false, message: "Connect Facebook first." }, { status: 400 });
  }
  const bm = await prisma.businessManager.findFirst({ where: { shop, isActive: true } });

  if (act === "list") {
    if (!bm) {
      const connected = await prisma.productCatalog.findMany({ where: { shop } });
      return json({
        ok: true,
        needsBusiness: true,
        catalogs: connected.map((c) => ({
          catalogId: c.catalogId,
          name: c.name,
          connected: true,
          isActive: c.isActive,
        })),
      });
    }
    const { listProductCatalogs } = await import("../lib/meta-ads.server");
    let remote: Array<{ id: string; name: string }> = [];
    try {
      remote = await listProductCatalogs(bm.businessId, tokenRecord.accessToken);
    } catch (e) {
      return json(
        { ok: false, message: e instanceof Error ? e.message : "Could not load catalogs." },
        { status: 500 },
      );
    }
    const connected = await prisma.productCatalog.findMany({ where: { shop } });
    const byId = new Map(connected.map((c) => [c.catalogId, c]));
    return json({
      ok: true,
      businessName: bm.name,
      catalogs: remote.map((c) => ({
        catalogId: c.id,
        name: c.name,
        connected: byId.has(c.id),
        isActive: byId.get(c.id)?.isActive ?? false,
      })),
    });
  }

  if (act === "create") {
    if (!bm) {
      return json(
        { ok: false, message: "Connect a Business Manager first (Accounts page)." },
        { status: 400 },
      );
    }
    const name = String(body.name ?? "").trim().slice(0, 100) || "AdPilot Catalog";
    const { createProductCatalog } = await import("../lib/meta-ads.server");
    try {
      const catalogId = await createProductCatalog(bm.businessId, name, tokenRecord.accessToken);
      await prisma.$transaction([
        prisma.productCatalog.updateMany({ where: { shop }, data: { isActive: false } }),
        prisma.productCatalog.upsert({
          where: { shop_catalogId: { shop, catalogId } },
          create: { shop, catalogId, name, businessId: bm.businessId, isActive: true },
          update: { name, businessId: bm.businessId, isActive: true },
        }),
      ]);
      return json({ ok: true, catalogId, message: `Catalog "${name}" created and connected.` });
    } catch (e) {
      return json(
        { ok: false, message: e instanceof Error ? e.message : "Could not create catalog." },
        { status: 500 },
      );
    }
  }

  const catalogId = String(body.catalogId ?? "").trim();
  if (!catalogId) {
    return json({ ok: false, message: "catalogId is required." }, { status: 400 });
  }

  if (act === "connect") {
    const name = String(body.name ?? "").trim() || "Product Catalog";
    await prisma.$transaction([
      prisma.productCatalog.updateMany({ where: { shop }, data: { isActive: false } }),
      prisma.productCatalog.upsert({
        where: { shop_catalogId: { shop, catalogId } },
        create: { shop, catalogId, name, businessId: bm?.businessId ?? null, isActive: true },
        update: { name, isActive: true },
      }),
    ]);
    return json({ ok: true, message: `Catalog "${name}" connected.` });
  }

  if (act === "set-active") {
    const existing = await prisma.productCatalog.findFirst({ where: { shop, catalogId } });
    if (!existing) {
      return json({ ok: false, message: "Catalog not connected." }, { status: 404 });
    }
    await prisma.$transaction([
      prisma.productCatalog.updateMany({ where: { shop }, data: { isActive: false } }),
      prisma.productCatalog.update({ where: { id: existing.id }, data: { isActive: true } }),
    ]);
    return json({ ok: true });
  }

  if (act === "disconnect") {
    await prisma.productCatalog.deleteMany({ where: { shop, catalogId } });
    return json({ ok: true, message: "Catalog disconnected." });
  }

  return json({ ok: false, message: "Unknown action." }, { status: 400 });
};
