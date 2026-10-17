import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { generateWithProvider, resolveProvidersAsync } from "../lib/ai.server";

/**
 * POST /api/ai/suggest-url
 * Body (JSON): { topic, objective }
 *
 * AI picks the best destination URL for the campaign based on its focus:
 * - Specific product mentioned → that product's URL
 * - Collection/category → collection URL
 * - General/brand → homepage
 *
 * Returns { ok, url, label, reason }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { topic?: unknown; objective?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const topic = String(body.topic ?? "").trim();
  const objective = String(body.objective ?? "").trim() || "TRAFFIC";
  if (!topic) {
    return json({ ok: false, error: "Campaign name is required." }, { status: 400 });
  }

  // Fetch products + collections for matching.
  const [prodRes, collRes] = await Promise.all([
    admin.graphql(
      `#graphql
      query { products(first: 30, sortKey: UPDATED_AT, reverse: true) {
        edges { node { title handle onlineStoreUrl } } } }`,
    ),
    admin.graphql(
      `#graphql
      query { collections(first: 20) {
        edges { node { title handle } } } }`,
    ),
  ]);
  const prodJson = await prodRes.json();
  const collJson = await collRes.json();
  const products: Array<{ title: string; handle: string; onlineStoreUrl?: string }> =
    prodJson?.data?.products?.edges?.map((e: any) => e.node) ?? [];
  const collections: Array<{ title: string; handle: string }> =
    collJson?.data?.collections?.edges?.map((e: any) => e.node) ?? [];

  const shopDomain = shop.replace(".myshopify.com", "");
  const homepage = `https://${shopDomain}.myshopify.com`;

  if (products.length === 0 && collections.length === 0) {
    return json({ ok: true, url: homepage, label: "Homepage", reason: "No products found — using homepage." });
  }

  // Build a compact list for the AI to choose from.
  const options = [
    ...products.slice(0, 30).map((p, i) => ({
      id: `p${i}`,
      label: p.title,
      url: p.onlineStoreUrl || `${homepage}/products/${p.handle}`,
      kind: "product",
    })),
    ...collections.slice(0, 20).map((c, i) => ({
      id: `c${i}`,
      label: c.title,
      url: `${homepage}/collections/${c.handle}`,
      kind: "collection",
    })),
    { id: "home", label: "Homepage", url: homepage, kind: "homepage" },
  ];

  const listText = options.map((o) => `- [${o.id}] (${o.kind}) ${o.label}`).join("\n");
  const systemPrompt = `You are a Meta ads strategist. Given a campaign topic and a list of store pages, pick the SINGLE best destination URL for the ad.

Rules:
- If the topic mentions a specific product, pick that product's page.
- If the topic is about a category/season/sale (e.g. "Summer Collection", "Winter Sale"), pick the most relevant collection. If no collection matches well, pick homepage.
- If the topic is general/brand awareness, pick homepage.
- Respond ONLY with JSON: {"pick": "<id>", "reason": "<one short sentence>"}`;

  const providers = await resolveProvidersAsync();
  if (providers.length === 0) {
    return json({ ok: false, error: "AI not configured." }, { status: 500 });
  }

  try {
    const { getAgentsForSector, getMainAgent, generateForSector } = await import(
      "../lib/agents.server"
    );
    const [specialized, main] = await Promise.all([
      getAgentsForSector("audience"),
      getMainAgent(),
    ]);
    let text: string;
    if (specialized.length > 0 || main) {
      const r = await generateForSector("audience", {
        systemPrompt,
        userPrompt: `Campaign objective: ${objective}\nCampaign topic: ${topic}\n\nAvailable pages:\n${listText}\n\nPick the best destination. Respond ONLY with JSON.`,
      });
      text = r.text;
    } else {
      const cfg = providers[0];
      text = await generateWithProvider(
        cfg,
        systemPrompt,
        `Campaign objective: ${objective}\nCampaign topic: ${topic}\n\nAvailable pages:\n${listText}\n\nPick the best destination. Respond ONLY with JSON.`,
      );
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI did not return JSON.");
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      pick?: string;
      reason?: string;
    };
    const chosen = options.find((o) => o.id === parsed.pick) ?? options[options.length - 1];
    return json({
      ok: true,
      url: chosen.url,
      label: chosen.label,
      reason: String(parsed.reason ?? "").slice(0, 200),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI suggestion failed.";
    return json({ ok: false, error: message }, { status: 500 });
  }
};
