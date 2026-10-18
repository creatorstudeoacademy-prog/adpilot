import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { chatWithProvider, resolveProvidersAsync } from "../lib/ai.server";
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/ai/suggest-field
 * Body (JSON): { field: "headline" | "primaryText" | "description", topic }
 *
 * Generates a single field suggestion. Small fee ($0.05) per use.
 */
const FEE = 0.05;

const FIELD_PROMPT: Record<string, string> = {
  headline: "Write ONE short punchy ad headline (max 60 characters). Return ONLY the headline text, nothing else.",
  primaryText:
    "Write ONE engaging Facebook ad primary text (2-3 sentences). Return ONLY the text, nothing else.",
  description:
    "Write ONE short ad description line (max 100 characters). Return ONLY the description, nothing else.",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { field?: unknown; topic?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const field = String(body.field ?? "");
  const topic = String(body.topic ?? "").trim();
  if (!FIELD_PROMPT[field]) {
    return json({ ok: false, error: "Unknown field." }, { status: 400 });
  }
  if (!topic) {
    return json({ ok: false, error: "Describe what the ad is about first." }, { status: 400 });
  }

  const free = isFreeShop(shop);
  if (!free) {
    const wallet = await getWallet(shop);
    if (wallet.balance < FEE) {
      return json(
        { ok: false, error: "Insufficient wallet balance.", needTopup: true },
        { status: 402 },
      );
    }
    await deduct(shop, FEE, `Suggestion for ${field}: ${topic.slice(0, 50)}`);
  }

  try {
    const providers = await resolveProvidersAsync();
    if (providers.length === 0) throw new Error("AI is not configured.");
    let suggestion = "";
    for (const cfg of providers) {
      try {
        suggestion = (
          await chatWithProvider(cfg, "You are a direct-response ad copywriter.", [
            { role: "user", content: `${FIELD_PROMPT[field]}\n\nProduct/campaign: ${topic}` },
          ])
        ).trim();
        break;
      } catch {
        // try next provider
      }
    }
    if (!suggestion) throw new Error("AI returned an empty suggestion.");
    logActivity({ shop, action: "ai_suggest", detail: field, feeCharged: free ? 0 : FEE });
    return json({ ok: true, suggestion, charged: free ? 0 : FEE });
  } catch (e) {
    if (!free) await refund(shop, FEE, "Suggestion failed — refunded");
    const message = e instanceof Error ? e.message : "Suggestion failed.";
    return json({ ok: false, error: message }, { status: 500 });
  }
};
