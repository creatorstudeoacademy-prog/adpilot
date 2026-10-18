import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken } from "../lib/token-vault.server";

const GRAPH_VERSION = "v21.0";

interface InsightsRow {
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  age?: string;
  gender?: string;
  country?: string;
  publisher_platform?: string;
  [key: string]: unknown;
}

function sumPurchases(row: InsightsRow): { purchases: number; value: number } {
  let purchases = 0;
  let value = 0;
  for (const a of row.actions ?? []) {
    const t = (a.action_type ?? "").toLowerCase();
    if (t === "purchase" || t === "offsite_conversion.fb_pixel_purchase") {
      purchases += parseFloat(a.value ?? "0") || 0;
    }
    if (t === "purchase" || t.includes("purchase")) {
      // value is tracked separately via action_values; keep simple
    }
  }
  return { purchases, value };
}

async function getInsights(
  adAccountId: string,
  token: string,
  breakdowns?: string,
): Promise<InsightsRow[]> {
  const params = new URLSearchParams({
    fields: "spend,impressions,clicks,actions",
    date_preset: "last_30d",
    limit: "100",
    access_token: token,
  });
  if (breakdowns) params.set("breakdowns", breakdowns);
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/act_${adAccountId}/insights?${params}`,
  );
  const data = (await res.json()) as {
    data?: InsightsRow[];
    error?: { message?: string; code?: number };
  };
  if (data.error) {
    const err = new Error(data.error.message ?? "Insights failed.") as Error & { metaCode?: number };
    err.metaCode = data.error.code;
    throw err;
  }
  return data.data ?? [];
}

/**
 * POST /api/ads/strategy
 * Body (JSON): { adAccountDbId? }
 *
 * The AI Ad Strategist: pulls 30 days of ad account performance
 * (totals + age/gender + country + placement breakdowns), then asks AI
 * to produce a concrete sales strategy: who to target, where to place,
 * what budget, and what creative angle — so merchants stop wasting budget
 * on guesswork.
 *
 * Returns { ok, strategy } where strategy is the AI JSON:
 * { score, verdict, bestAudience {ageMin, ageMax, genders, countries},
 *   placements {mode, detail}, budget {minDaily, recommendedDaily, note},
 *   creativeGuidance[], risks[], recommendations[] }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { adAccountDbId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const adAccount = body.adAccountDbId
    ? await prisma.adAccount.findFirst({ where: { id: String(body.adAccountDbId), shop } })
    : await prisma.adAccount.findFirst({ where: { shop }, orderBy: { createdAt: "asc" } });
  if (!adAccount) {
    return json({ ok: false, message: "Connect an ad account first." }, { status: 400 });
  }

  const { checkRateLimit, rateLimitMessage } = await import("../lib/rate-limit.server");
  const rl = await checkRateLimit(shop, "analyze_campaign");
  if (!rl.ok) {
    return json({ ok: false, message: rateLimitMessage("analyze_campaign", rl.limit) }, { status: 429 });
  }

  const token = decryptToken(adAccount.accessToken);

  // Pull performance data.
  let totals: InsightsRow[] = [];
  let byAgeGender: InsightsRow[] = [];
  let byCountry: InsightsRow[] = [];
  let byPlatform: InsightsRow[] = [];
  try {
    [totals, byAgeGender, byCountry, byPlatform] = await Promise.all([
      getInsights(adAccount.adAccountId, token),
      getInsights(adAccount.adAccountId, token, "age,gender"),
      getInsights(adAccount.adAccountId, token, "country"),
      getInsights(adAccount.adAccountId, token, "publisher_platform"),
    ]);
  } catch (e) {
    const metaCode = (e as Error & { metaCode?: number }).metaCode;
    if (metaCode === 100) {
      return json({
        ok: false,
        needsApproval: true,
        message:
          "Meta hasn't approved your app's ad permissions yet. The AI Strategist unlocks automatically once Meta approves your App Review — nothing to fix in the app.",
      });
    }
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Could not read ad performance." },
      { status: 500 },
    );
  }

  const t = totals[0] ?? {};
  const spend = parseFloat(t.spend ?? "0") || 0;
  const impressions = parseInt(t.impressions ?? "0", 10) || 0;
  const clicks = parseInt(t.clicks ?? "0", 10) || 0;
  const { purchases } = sumPurchases(t);

  const fmtRows = (rows: InsightsRow[], keys: string[]) =>
    rows
      .map((r) => {
        const label = keys.map((k) => `${k}=${r[k] ?? "?"}`).join(" ");
        const { purchases: p } = sumPurchases(r);
        return `- ${label}: spend ${r.spend ?? 0}, impressions ${r.impressions ?? 0}, clicks ${r.clicks ?? 0}, purchases ${p}`;
      })
      .join("\n");

  const systemPrompt = `You are an elite Meta ads strategist for small e-commerce brands. Given 30 days of real ad account performance, produce a concrete, budget-protecting sales strategy.

Rules:
- Base EVERY recommendation on the actual numbers. If data is thin (low spend, no purchases), say so and give a safe testing plan instead of pretending.
- Be specific: exact age range, countries, placements, daily budget numbers in the account currency.
- Placements: recommend "advantage" (Advantage+ placements, Meta's automatic) unless the data clearly shows a manual placement wins. Never recommend more than 3 manual placements.
- Budget: never recommend more than the merchant has proven. Start small, scale winners.
- The merchant's goal is sales without wasted budget. Protect their money like it's your own.
- Respond with ONLY a single JSON object, no markdown fences, no extra text. Use this exact shape:
{
  "score": <0-100: how ready/healthy the ad data is for scaling>,
  "verdict": "<one-sentence overall verdict>",
  "bestAudience": {
    "ageMin": <number>, "ageMax": <number>,
    "genders": ["<all|men|women>"],
    "countries": ["<ISO codes>"],
    "reason": "<why, in one sentence>"
  },
  "placements": {
    "mode": "<advantage|manual>",
    "detail": "<which placements and why, one sentence>"
  },
  "budget": {
    "minDaily": <number>, "recommendedDaily": <number>, "currency": "<code>",
    "note": "<one sentence>"
  },
  "creativeGuidance": ["<concrete creative advice based on what got clicks>", ...],
  "risks": ["<what could waste their budget>", ...],
  "recommendations": [
    {"title": "<short action title>", "detail": "<1-2 sentence explanation>", "priority": "high|medium|low"},
    ...
  ]
}`;

  const userPrompt =
    `Ad account: ${adAccount.adAccountName} (${adAccount.adAccountId}), currency ${adAccount.currency ?? "USD"}\n` +
    `Last 30 days totals: spend ${spend.toFixed(2)}, impressions ${impressions}, clicks ${clicks}, purchases ${purchases}\n` +
    `\nBy age/gender:\n${fmtRows(byAgeGender, ["age", "gender"]) || "(no data)"}\n` +
    `\nBy country:\n${fmtRows(byCountry, ["country"]) || "(no data)"}\n` +
    `\nBy platform:\n${fmtRows(byPlatform, ["publisher_platform"]) || "(no data)"}\n` +
    `\nBuild the sales strategy. What exact setup (age, location, placements, budget, creative) should this merchant use so they don't waste money?`;

  try {
    const { generateForSector, getAgentsForSector, getMainAgent } = await import(
      "../lib/agents.server"
    );
    const [specialized, main] = await Promise.all([getAgentsForSector("campaign"), getMainAgent()]);
    let text: string;
    if (specialized.length > 0 || main) {
      const r = await generateForSector("campaign", { systemPrompt, userPrompt });
      text = r.text;
    } else {
      const { generateWithProvider, resolveProvidersAsync } = await import("../lib/ai.server");
      const providers = await resolveProvidersAsync();
      if (providers.length === 0) throw new Error("AI not configured.");
      text = await generateWithProvider(providers[0], systemPrompt, userPrompt);
    }
    await prisma.activityLog.create({
      data: {
        shop,
        action: "ad_strategy",
        detail: `AI strategy generated for ${adAccount.adAccountName}`,
      },
    });
    return json({ ok: true, strategy: text.trim(), accountName: adAccount.adAccountName });
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Strategy generation failed." },
      { status: 500 },
    );
  }
};
