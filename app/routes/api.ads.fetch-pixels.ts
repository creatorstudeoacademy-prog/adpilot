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
 * Returns { ok, pixels: [{ id, name }] }.
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
    return json({ ok: true, pixels });
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Failed to fetch pixels." },
      { status: 500 },
    );
  }
};
