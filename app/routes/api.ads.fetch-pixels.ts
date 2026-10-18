import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * POST /api/ads/fetch-pixels
 * Body (JSON): { id } — the AdPilot AdAccount DB id.
 *
 * Fetches the Meta Pixels assigned to the ad account via
 * /act_{adAccountId}/adspixels using the shop's Meta user token.
 * If the ad account has no pixels and a Business Manager is connected,
 * falls back to collecting pixels across all of the business's ad accounts.
 * Returns { ok, pixels: [{ id, name }], source: "account" | "business" }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { id?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const id = String(body.id ?? "").trim();
  if (!id) {
    return json({ ok: false, message: "Ad account id is required." }, { status: 400 });
  }

  const account = await prisma.adAccount.findFirst({ where: { id, shop } });
  if (!account) {
    return json({ ok: false, message: "Ad account not found." }, { status: 404 });
  }
  const tokenRecord = await prisma.metaUserToken.findFirst({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  if (!tokenRecord) {
    return json({ ok: false, message: "Connect Facebook first." }, { status: 400 });
  }

  try {
    const { getAdPixels } = await import("../lib/meta-ads.server");
    const pixels = await getAdPixels(account.adAccountId, tokenRecord.accessToken);
    if (pixels.length > 0) {
      return json({ ok: true, pixels, source: "account" });
    }
    // Fallback: no pixels on this ad account — look across the whole
    // connected Business Manager (pixel may be assigned to another account).
    const bm = await prisma.businessManager.findFirst({ where: { shop, isActive: true } });
    if (bm) {
      const { decryptToken } = await import("../lib/token-vault.server");
      const token = decryptToken(tokenRecord.accessToken);
      const seen = new Map<string, string>();
      for (const edge of ["owned_ad_accounts", "client_ad_accounts"]) {
        try {
          const res = await fetch(
            `https://graph.facebook.com/v21.0/${bm.businessId}/${edge}?fields=id,adspixels{id,name}&limit=50&access_token=${token}`,
          );
          const data = (await res.json()) as {
            data?: Array<{ adspixels?: { data?: Array<{ id?: string; name?: string }> } }>;
          };
          for (const acct of data.data ?? []) {
            for (const px of acct.adspixels?.data ?? []) {
              if (px.id && !seen.has(px.id)) seen.set(px.id, px.name ?? px.id);
            }
          }
        } catch {
          // best-effort per edge
        }
      }
      if (seen.size > 0) {
        return json({
          ok: true,
          pixels: [...seen.entries()].map(([id, name]) => ({ id, name })),
          source: "business",
        });
      }
    }
    return json({ ok: true, pixels: [], source: "account" });
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Failed to fetch pixels." },
      { status: 500 },
    );
  }
};
