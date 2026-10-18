import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCampaignInsights } from "../lib/meta-ads.server";
import { generateWithProvider, resolveProvidersAsync } from "../lib/ai.server";

/**
 * POST /api/ai/analyze-campaign
 * Body (JSON): { campaignId } (AdPilot campaign DB id)
 *
 * Fetches Meta insights for the campaign and asks AI to analyze
 * performance + give actionable recommendations.
 * Returns { ok, analysis } where analysis is markdown text.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { campaignId?: unknown; metaCampaignId?: unknown; adAccountId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const campaignId = String(body.campaignId ?? "");
  const metaCampaignIdDirect = String(body.metaCampaignId ?? "");
  const adAccountIdDirect = String(body.adAccountId ?? "");

  const { checkRateLimit, rateLimitMessage } = await import("../lib/rate-limit.server");
  const rl = await checkRateLimit(shop, "analyze_campaign");
  if (!rl.ok) {
    return json({ ok: false, error: rateLimitMessage("analyze_campaign", rl.limit) }, { status: 429 });
  }

  let metaCampaignId: string;
  let accessToken: string;
  let campaignName = "Meta campaign";
  let campaignObjective = "unknown";
  let campaignStatus = "unknown";
  let campaignBudget: number | null = null;

  if (metaCampaignIdDirect && adAccountIdDirect) {
    // Direct Meta campaign (created in Meta Ads Manager, no DB record).
    const adAccount = await prisma.adAccount.findFirst({
      where: { adAccountId: adAccountIdDirect, shop },
    });
    if (!adAccount) {
      return json({ ok: false, error: "Ad account not connected." }, { status: 400 });
    }
    metaCampaignId = metaCampaignIdDirect;
    accessToken = adAccount.accessToken;
  } else {
    if (!campaignId) {
      return json({ ok: false, error: "campaignId required." }, { status: 400 });
    }
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, shop },
      include: { adAccount: true },
    });
    if (!campaign?.metaCampaignId) {
      return json({ ok: false, error: "Campaign not published to Meta yet." }, { status: 400 });
    }
    metaCampaignId = campaign.metaCampaignId;
    accessToken = campaign.adAccount.accessToken;
    campaignName = campaign.name;
    campaignObjective = campaign.objective;
    campaignStatus = campaign.status;
    campaignBudget = campaign.dailyBudget;
  }

  let insights;
  try {
    insights = await getCampaignInsights(metaCampaignId, accessToken);
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Could not fetch insights." },
      { status: 500 },
    );
  }

  const systemPrompt = `You are a Meta ads analyst for e-commerce brands. Analyze campaign performance data and give clear, actionable advice.

Rules:
- Be specific: reference actual numbers (CTR, CPC, spend, etc.)
- Give 2-4 concrete recommendations (budget, targeting, creative, etc.)
- If spend is $0 or impressions are 0, explain likely causes (paused, under review, billing issue, etc.)
- Keep it concise: use short bullet points, no fluff.
- No fake benchmarks — compare against general e-commerce norms only when useful.
- Respond in plain text with simple formatting (no JSON).`;

  const userPrompt =
    `Analyze this Meta ad campaign (last 30 days):\n` +
    `Name: ${campaignName}\n` +
    `Objective: ${campaignObjective}\n` +
    `Status: ${campaignStatus}\n` +
    `Daily budget: $${campaignBudget != null ? campaignBudget.toFixed(2) : "n/a"}\n` +
    `Impressions: ${insights.impressions}\n` +
    `Reach: ${insights.reach ?? "n/a"}\n` +
    `Clicks: ${insights.clicks}\n` +
    `Spend: $${insights.spend.toFixed(2)}\n` +
    `CTR: ${insights.ctr.toFixed(2)}%\n` +
    `CPC: $${insights.cpc.toFixed(2)}\n` +
    `CPM: $${insights.cpm.toFixed(2)}\n` +
    (insights.actions?.length
      ? `Conversions: ${insights.actions.map((a) => `${a.action_type}=${a.value}`).join(", ")}\n`
      : "") +
    `\nWhat is working, what is not, and what should the merchant do next?`;

  try {
    const { getAgentsForSector, getMainAgent, generateForSector } = await import(
      "../lib/agents.server"
    );
    const [specialized, main] = await Promise.all([
      getAgentsForSector("campaign"),
      getMainAgent(),
    ]);
    let text: string;
    if (specialized.length > 0 || main) {
      const r = await generateForSector("campaign", { systemPrompt, userPrompt });
      text = r.text;
    } else {
      const providers = await resolveProvidersAsync();
      if (providers.length === 0) throw new Error("AI not configured.");
      text = await generateWithProvider(providers[0], systemPrompt, userPrompt);
    }
    await prisma.activityLog.create({
      data: { shop, action: "analyze_campaign", detail: `campaign analysis: ${campaignName}` },
    });
    return json({ ok: true, analysis: text.trim(), insights });
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Analysis failed." },
      { status: 500 },
    );
  }
};
