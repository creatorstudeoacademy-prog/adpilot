import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * POST /api/ads/pixel-health
 * Body (JSON): { pixelId }
 *
 * Pixel health check: recency of events, assignment to ad accounts,
 * then AI analysis -> structured JSON { score, verdict, strengths,
 * weaknesses, recommendations } (same shape as campaign analysis).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { pixelId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const pixelId = String(body.pixelId ?? "").trim();
  if (!pixelId) {
    return json({ ok: false, message: "pixelId is required." }, { status: 400 });
  }

  const tokenRecord = await prisma.metaUserToken.findFirst({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  if (!tokenRecord) {
    return json({ ok: false, message: "Connect Facebook first." }, { status: 400 });
  }

  const { checkRateLimit, rateLimitMessage } = await import("../lib/rate-limit.server");
  const rl = await checkRateLimit(shop, "analyze_campaign");
  if (!rl.ok) {
    return json({ ok: false, message: rateLimitMessage("analyze_campaign", rl.limit) }, { status: 429 });
  }

  const { getPixelInfo } = await import("../lib/meta-ads.server");
  let info: { id: string; name?: string; last_fired_time?: string; creation_time?: string; data_use_setting?: string };
  try {
    info = await getPixelInfo(pixelId, tokenRecord.accessToken);
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Could not read pixel." },
      { status: 500 },
    );
  }

  // Which of the shop's ad accounts is this pixel saved on / assigned to?
  const adAccounts = await prisma.adAccount.findMany({ where: { shop } });
  const savedOn = adAccounts.filter((a) => a.pixelId === pixelId).map((a) => a.adAccountName);

  const now = Date.now();
  const lastFired = info.last_fired_time ? new Date(info.last_fired_time).getTime() : null;
  const hoursSinceFire = lastFired ? (now - lastFired) / 36e5 : null;

  const systemPrompt = `You are a Meta Pixel health analyst for e-commerce brands. Given pixel metadata, judge how healthy the tracking setup is and what to fix.

Rules:
- Be specific: reference actual values (last fired time, assignment, etc.)
- If the pixel never fired or fired long ago, say so plainly and explain likely causes (not installed, installed on wrong domain, ad blocker testing, etc.)
- Keep it concise: short bullet points, no fluff.
- Respond with ONLY a single JSON object, no markdown fences, no extra text. Use this exact shape:
{
  "score": <0-100 health score>,
  "verdict": "<one-sentence overall verdict>",
  "strengths": ["<what is healthy>", ...],
  "weaknesses": ["<what is wrong or risky>", ...],
  "recommendations": [
    {"title": "<short action title>", "detail": "<1-2 sentence explanation>", "priority": "high|medium|low"},
    ...
  ]
}`;

  const userPrompt =
    `Pixel health check:\n` +
    `Pixel ID: ${info.id}\n` +
    `Name: ${info.name ?? "n/a"}\n` +
    `Created: ${info.creation_time ?? "n/a"}\n` +
    `Last event received: ${info.last_fired_time ?? "NEVER"}` +
    (hoursSinceFire != null ? ` (${hoursSinceFire < 1 ? "less than an hour" : `${Math.round(hoursSinceFire)} hours`} ago)` : "") +
    `\n` +
    `Assigned to ad accounts in AdPilot: ${savedOn.length > 0 ? savedOn.join(", ") : "NONE"}\n` +
    `\nIs this pixel healthy? What should the merchant fix?`;

  try {
    const { generateForSector } = await import("../lib/agents.server");
    const { getAgentsForSector, getMainAgent } = await import("../lib/agents.server");
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
      data: { shop, action: "pixel_health_check", detail: `pixel ${pixelId} health analyzed` },
    });
    return json({
      ok: true,
      analysis: text.trim(),
      pixel: {
        id: info.id,
        name: info.name ?? null,
        lastFired: info.last_fired_time ?? null,
        hoursSinceFire: hoursSinceFire != null ? Math.round(hoursSinceFire) : null,
        savedOn,
      },
    });
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Analysis failed." },
      { status: 500 },
    );
  }
};
