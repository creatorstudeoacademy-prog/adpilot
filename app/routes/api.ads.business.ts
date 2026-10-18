import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken } from "../lib/token-vault.server";

const GRAPH_VERSION = "v21.0";

interface BusinessNode {
  id?: string;
  name?: string;
  verification_status?: string;
}

async function fetchBusinesses(accessToken: string): Promise<BusinessNode[]> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/businesses?fields=id,name,verification_status&limit=50&access_token=${decryptToken(accessToken)}`,
  );
  const data = (await res.json()) as { data?: BusinessNode[]; error?: { message?: string } };
  if (data.error) throw new Error(data.error.message ?? "Could not load businesses.");
  return data.data ?? [];
}

/**
 * POST /api/ads/business
 * Body (JSON): { action: "list" | "connect" | "set-active" | "disconnect", businessId?, name? }
 *
 * - list: businesses on the Meta account (via user token) + which are connected/active in AdPilot.
 * - connect: connect a Business Manager (stores it, sets as active).
 * - set-active: switch the active Business Manager.
 * - disconnect: remove a connected Business Manager.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { action?: unknown; businessId?: unknown; name?: unknown } = {};
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

  if (act === "list") {
    let remote: BusinessNode[] = [];
    try {
      remote = await fetchBusinesses(tokenRecord.accessToken);
    } catch (e) {
      return json(
        { ok: false, message: e instanceof Error ? e.message : "Could not load businesses." },
        { status: 500 },
      );
    }
    const connected = await prisma.businessManager.findMany({ where: { shop } });
    const byId = new Map(connected.map((c) => [c.businessId, c]));
    return json({
      ok: true,
      businesses: remote.map((b) => ({
        businessId: b.id ?? "",
        name: b.name ?? "Business Manager",
        verificationStatus: b.verification_status ?? "unknown",
        connected: byId.has(b.id ?? ""),
        isActive: byId.get(b.id ?? "")?.isActive ?? false,
      })),
    });
  }

  const businessId = String(body.businessId ?? "").trim();
  if (!businessId) {
    return json({ ok: false, message: "businessId is required." }, { status: 400 });
  }

  if (act === "connect") {
    const name = String(body.name ?? "").trim() || "Business Manager";
    await prisma.$transaction([
      prisma.businessManager.updateMany({ where: { shop }, data: { isActive: false } }),
      prisma.businessManager.upsert({
        where: { shop_businessId: { shop, businessId } },
        create: { shop, businessId, name, isActive: true },
        update: { name, isActive: true },
      }),
    ]);
    return json({ ok: true, message: `"${name}" connected.` });
  }

  if (act === "set-active") {
    const existing = await prisma.businessManager.findFirst({ where: { shop, businessId } });
    if (!existing) {
      return json({ ok: false, message: "Business Manager not connected." }, { status: 404 });
    }
    await prisma.$transaction([
      prisma.businessManager.updateMany({ where: { shop }, data: { isActive: false } }),
      prisma.businessManager.update({ where: { id: existing.id }, data: { isActive: true } }),
    ]);
    return json({ ok: true });
  }

  if (act === "disconnect") {
    await prisma.businessManager.deleteMany({ where: { shop, businessId } });
    return json({ ok: true, message: "Business Manager disconnected." });
  }

  return json({ ok: false, message: "Unknown action." }, { status: 400 });
};
