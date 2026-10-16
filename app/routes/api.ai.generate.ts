import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import { AI_GENERATION_FEE } from "../lib/pricing";
import { generateCaption, listProviders } from "../lib/ai.server";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/ai/generate — AI caption generator.
 * Body (JSON): { topic, platform: "facebook"|"instagram", tone }
 * Charges AI_GENERATION_FEE ($0.20) from the wallet, then generates.
 * Refunds the fee if generation fails (merchant got nothing).
 * Returns { ok, caption, hashtags, provider } or { ok:false, error, message }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { topic?: unknown; platform?: unknown; tone?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const topic = String(body.topic ?? "").trim();
  const platform = String(body.platform ?? "facebook").toLowerCase();
  const tone = String(body.tone ?? "Professional");

  if (!topic) {
    return json(
      { ok: false, error: "EMPTY_TOPIC", message: "Tell the AI what the post is about." },
      { status: 400 },
    );
  }

  // Fail fast (no charge) when no provider is configured.
  if (listProviders().length === 0) {
    return json(
      {
        ok: false,
        error: "AI_NOT_CONFIGURED",
        message:
          "AI is not configured yet. The store owner needs to add AI provider keys (see AI_SETUP.md).",
      },
      { status: 503 },
    );
  }

  // Wallet check + deduct BEFORE calling the AI (same pattern as post publish).
  // Free shops (owner's own stores) skip the balance check entirely.
  const wallet = await getWallet(shop);
  if (!isFreeShop(shop) && wallet.balance < AI_GENERATION_FEE) {
    return json(
      {
        ok: false,
        error: "INSUFFICIENT_WALLET",
        message: `Insufficient wallet balance ($${wallet.balance.toFixed(2)}). AI generation costs $${AI_GENERATION_FEE.toFixed(2)} — please top up.`,
      },
      { status: 402 },
    );
  }
  await deduct(shop, AI_GENERATION_FEE, "AI caption generation", undefined);

  try {
    const result = await generateCaption({ topic, platform, tone });
    logActivity({
      shop,
      action: "ai_generate",
      detail: `sector:caption provider:${result.provider}${result.agent ? ` agent:${result.agent}` : ""} platform:${platform} tone:${tone} topic:${topic.slice(0, 80)}`,
      feeCharged: isFreeShop(shop) ? 0 : AI_GENERATION_FEE,
      agentName: result.agent,
    });
    return json({
      ok: true,
      caption: result.caption,
      hashtags: result.hashtags,
      provider: result.provider,
    });
  } catch (e) {
    // Merchant got nothing — refund the generation fee.
    await refund(shop, AI_GENERATION_FEE, "Refund: AI generation failed", undefined);
    const message = e instanceof Error ? e.message : "AI generation failed.";
    console.error("[adpilot ai] generation failed:", message);
    logActivity({
      shop,
      action: "ai_generate",
      detail: `failed: ${message.slice(0, 140)}`,
      feeCharged: 0,
    });
    return json({ ok: false, error: "AI_FAILED", message }, { status: 502 });
  }
};
