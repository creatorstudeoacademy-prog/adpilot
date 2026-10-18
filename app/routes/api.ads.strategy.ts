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
  const { session, admin } = await authenticate.admin(request);
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

  /* ---- Real order data (ground truth — beats ad-reported numbers) ---- */
  let orderContext = "Real Shopify order data: unavailable (read_orders scope not granted yet).";
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ores = await admin.graphql(
      `#graphql
      query($since: String!) {
        orders(first: 100, query: $since, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              name
              test
              displayFinancialStatus
              totalPriceSet { shopMoney { amount currencyCode } }
            }
          }
        }
      }`,
      { variables: { since: `created_at:>=${since}` } },
    );
    const odata = (await ores.json()) as any;
    const onodes: Array<{ test: boolean; displayFinancialStatus: string; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } }> =
      (odata?.data?.orders?.edges ?? []).map((e: any) => e.node);
    const real = onodes.filter((o) => !o.test);
    const testCount = onodes.length - real.length;
    const revenue = real.reduce((sum, o) => sum + parseFloat(o.totalPriceSet.shopMoney.amount || "0"), 0);
    orderContext = `Real Shopify orders (last 30 days): ${real.length} real orders, ${revenue.toFixed(2)} ${real[0]?.totalPriceSet.shopMoney.currencyCode ?? ""} revenue.`;
    if (testCount > 0) {
      orderContext += ` WARNING: ${testCount} TEST/FAKE orders detected — these pollute pixel data. Tell the merchant to delete them from Shopify Orders and stop firing test events without a test_event_code. Base your strategy ONLY on the ${real.length} real orders.`;
    }
  } catch {
    /* scope not granted yet — AI works with Meta data only */
  }

  /* ---- Deep research: the merchant's TOTAL business picture ---- */
  const biz: {
    page?: { name?: string; followers?: number; fans?: number };
    catalog?: { name?: string; productCount?: number; priceRange?: string; sample?: string[] };
    pixels?: Array<{ id: string; name?: string; lastFired?: string | null }>;
  } = {};

  // Facebook Page (social proof + organic audience signal).
  const fbPage = await prisma.socialAccount.findFirst({ where: { shop, platform: "facebook" } });
  if (fbPage?.pageId) {
    try {
      const pr = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${fbPage.pageId}?fields=name,followers_count,fan_count&access_token=${token}`,
      );
      const pd = (await pr.json()) as { name?: string; followers_count?: number; fan_count?: number };
      if (!pd.error) {
        biz.page = { name: pd.name, followers: pd.followers_count, fans: pd.fan_count };
      }
    } catch {
      // page data is a bonus signal; skip on failure
    }
  }

  // Product catalog (what they sell, price points).
  const activeCatalog = await prisma.productCatalog.findFirst({ where: { shop, isActive: true } });
  if (activeCatalog) {
    try {
      const { listCatalogProducts } = await import("../lib/meta-ads.server");
      const products = await listCatalogProducts(activeCatalog.catalogId, token);
      const prices = products
        .map((pr) => parseFloat(String(pr.price ?? "").replace(/[^0-9.]/g, "")) || 0)
        .filter((n) => n > 0);
      biz.catalog = {
        name: activeCatalog.name,
        productCount: products.length,
        priceRange:
          prices.length > 0
            ? `${Math.min(...prices).toFixed(2)} – ${Math.max(...prices).toFixed(2)}`
            : "n/a",
        sample: products.slice(0, 8).map((pr) => `${pr.name ?? "?"} (${pr.price ?? "n/a"})`),
      };
    } catch {
      // catalog read may need approval; skip on failure
    }
  }

  // Pixels (tracking health = data quality signal).
  const savedPixels = await prisma.adAccount.findMany({
    where: { shop, pixelId: { not: null } },
    select: { pixelId: true },
  });
  const pixelIds = [...new Set(savedPixels.map((a) => a.pixelId).filter(Boolean) as string[])];
  if (pixelIds.length > 0) {
    try {
      const { getPixelInfo } = await import("../lib/meta-ads.server");
      biz.pixels = await Promise.all(
        pixelIds.slice(0, 3).map(async (pid) => {
          try {
            const info = await getPixelInfo(pid, token);
            return { id: pid, name: info.name, lastFired: info.last_fired_time ?? null };
          } catch {
            return { id: pid, lastFired: null };
          }
        }),
      );
    } catch {
      // skip on failure
    }
  }

  const fmtRows = (rows: InsightsRow[], keys: string[]) =>
    rows
      .map((r) => {
        const label = keys.map((k) => `${k}=${r[k] ?? "?"}`).join(" ");
        const { purchases: p } = sumPurchases(r);
        return `- ${label}: spend ${r.spend ?? 0}, impressions ${r.impressions ?? 0}, clicks ${r.clicks ?? 0}, purchases ${p}`;
      })
      .join("\n");

  // Chart data for the animated report UI.
  const toChartRows = (rows: InsightsRow[], label: (r: InsightsRow) => string) =>
    rows
      .map((r) => {
        const spend = parseFloat(r.spend ?? "0") || 0;
        const { purchases } = sumPurchases(r);
        const clicks = parseInt(String(r.clicks ?? "0"), 10) || 0;
        const impressions = parseInt(String(r.impressions ?? "0"), 10) || 0;
        return {
          label: label(r),
          spend: Math.round(spend * 100) / 100,
          purchases,
          ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0,
          cpp: purchases > 0 ? Math.round((spend / purchases) * 100) / 100 : null,
        };
      })
      .filter((r) => r.spend > 0)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 6);
  const chartData = {
    totals: {
      spend: Math.round(spend * 100) / 100,
      impressions,
      clicks,
      purchases,
      ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0,
      currency: adAccount.currency ?? "USD",
    },
    byCountry: toChartRows(byCountry, (r) => String(r.country ?? "?").toUpperCase()),
    byAgeGender: toChartRows(
      byAgeGender,
      (r) => `${r.age ?? "?"} ${r.gender === "male" ? "♂" : r.gender === "female" ? "♀" : ""}`.trim(),
    ),
    byPlatform: toChartRows(byPlatform, (r) => {
      const pf = String(r.publisher_platform ?? "?");
      return pf === "facebook"
        ? "Facebook"
        : pf === "instagram"
          ? "Instagram"
          : pf === "audience_network"
            ? "Audience Network"
            : pf === "messenger"
              ? "Messenger"
              : pf;
    }),
  };

  const systemPrompt = `You are a senior Meta ads media buyer with 10 years of experience scaling e-commerce brands. You have been handed the merchant's TOTAL business picture — not just ad numbers, but their Facebook Page (social proof), their product catalog (what they sell and at what price), their pixel health (tracking quality), and 30 days of ad performance.

Do a deep expert analysis like you would for a paying client:
- Connect the dots: does their catalog price point match the audience? Does their Page following give them social proof to leverage? Is their pixel healthy enough to optimize for purchases, or should they optimize for clicks first?
- If the pixel never fired, be blunt: they cannot run purchase-optimized ads yet — say exactly what to fix first.
- If data is thin (low spend, no purchases), give a safe testing plan instead of pretending.

Rules:
- Base EVERY recommendation on the actual data below. Reference specific numbers.
- Be specific: exact age range, countries, placements, daily budget numbers in the account currency.
- Placements: recommend "advantage" (Advantage+ placements, Meta's automatic) unless the data clearly shows a manual placement wins. Never recommend more than 3 manual placements.
- Budget: never recommend more than the merchant has proven. Start small, scale winners. Tie the budget to the catalog price point (e.g. don't suggest $50/day to sell a $5 item with no data).
- Creative: tailor advice to their actual products (use product names from the catalog).
- The merchant's goal is sales without wasted budget. Protect their money like it's your own.
- CRITICAL: keep the whole response SHORT. verdict: 1 sentence. reason/note/detail: 1 sentence each. creativeGuidance: max 3 items, 1 sentence each. risks: max 3 items, 1 sentence each. recommendations: max 3 items. Never exceed ~350 words total — the response must fit completely, never cut off mid-sentence.
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

  const bizLines: string[] = [];
  if (biz.page) {
    bizLines.push(
      `Facebook Page: ${biz.page.name ?? "?"} — ${biz.page.followers?.toLocaleString() ?? "?"} followers, ${biz.page.fans?.toLocaleString() ?? "?"} fans`,
    );
  }
  if (biz.catalog) {
    bizLines.push(
      `Product catalog "${biz.catalog.name ?? "?"}": ${biz.catalog.productCount ?? 0} products, price range ${biz.catalog.priceRange ?? "n/a"}`,
    );
    if (biz.catalog.sample?.length) {
      bizLines.push(`Sample products: ${biz.catalog.sample.join(" | ")}`);
    }
  }
  if (biz.pixels?.length) {
    bizLines.push(
      `Pixels: ${biz.pixels.map((px) => `${px.name ?? px.id} (last event: ${px.lastFired ?? "NEVER"})`).join(" | ")}`,
    );
  }
  const userPrompt =
    `Ad account: ${adAccount.adAccountName} (${adAccount.adAccountId}), currency ${adAccount.currency ?? "USD"}\n` +
    `Last 30 days totals: spend ${spend.toFixed(2)}, impressions ${impressions}, clicks ${clicks}, purchases ${purchases}\n` +
    `\nBy age/gender:\n${fmtRows(byAgeGender, ["age", "gender"]) || "(no data)"}\n` +
    `\nBy country:\n${fmtRows(byCountry, ["country"]) || "(no data)"}\n` +
    `\nBy platform:\n${fmtRows(byPlatform, ["publisher_platform"]) || "(no data)"}\n` +
    `\nREAL STORE ORDERS (ground truth — trust over ad numbers):\n${orderContext}\n` +
    (bizLines.length > 0 ? `\nTOTAL BUSINESS PICTURE:\n${bizLines.join("\n")}\n` : "") +
    `\nAs a senior media buyer, analyze this merchant's whole business and build the sales strategy. What exact setup (age, location, placements, budget, creative) should they use so they don't waste money? What should they fix first?`;

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
    return json({
      ok: true,
      strategy: text.trim(),
      accountName: adAccount.adAccountName,
      chartData,
    });
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Strategy generation failed." },
      { status: 500 },
    );
  }
};
