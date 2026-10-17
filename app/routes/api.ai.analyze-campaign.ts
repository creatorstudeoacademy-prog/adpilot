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

  let body: { campaignId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const campaignId = String(body.campaignId ?? "");
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

  let insights;
  try {
    insights = await getCampaignInsights(
      campaign.metaCampaignId,
      campaign.adAccount.accessToken,
    );
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
    `Name: ${campaign.name}\n` +
    `Objective: ${campaign.objective}\n` +
    `Status: ${campaign.status}\n` +
    `Daily budget: $${campaign.dailyBudget}\n` +
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
      data: { shop, action: "ai_generate", detail: `campaign analysis: ${campaign.name}` },
    });
    return json({ ok: true, analysis: text.trim(), insights });
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Analysis failed." },
      { status: 500 },
    );
  }
};
