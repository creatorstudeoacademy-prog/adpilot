import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import {
  chatWithProvider,
  resolveProvidersAsync,
  type ChatTurn,
} from "../lib/ai.server";

/**
 * POST /api/schedule/suggest-topics — AI suggests post topics for a goal.
 * Body: { goal: string }
 * Returns { ok, topics: string[] } (5 suggestions). Free, no charge.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const { checkRateLimit, rateLimitMessage } = await import("../lib/rate-limit.server");
  const rl = await checkRateLimit(shop, "suggest_topics");
  if (!rl.ok) {
    return json({ ok: false, error: rateLimitMessage("suggest_topics", rl.limit) }, { status: 429 });
  }

  let body: { goal?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const goal = String(body.goal ?? "").trim().slice(0, 300);
  if (!goal) {
    return json({ ok: false, error: "MISSING", message: "Pick a goal first." }, { status: 400 });
  }

  const providers = await resolveProvidersAsync();
  if (providers.length === 0) {
    return json({ ok: false, error: "AI_NOT_CONFIGURED", message: "AI not configured." }, { status: 503 });
  }

  const systemPrompt = `You suggest Facebook post topics for Shopify merchants. Return ONLY a JSON array of 5 short topic ideas (each under 12 words), no other text. Example: ["New winter jacket collection reveal", "Behind the scenes: packing orders"]`;
  const turns: ChatTurn[] = [
    { role: "user", content: `Goal: ${goal}\nSuggest 5 Facebook post topics. Return ONLY the JSON array.` },
  ];

  let raw = "";
  for (const cfg of providers) {
    try {
      raw = await chatWithProvider(cfg, systemPrompt, turns);
      break;
    } catch {
      // try next
    }
  }
  if (!raw) {
    return json({ ok: false, error: "AI_FAILED", message: "Couldn't suggest topics." }, { status: 502 });
  }

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const topics = JSON.parse(match ? match[0] : raw) as string[];
    if (!Array.isArray(topics)) throw new Error("not array");
    const { logActivity } = await import("../lib/activity.server");
    logActivity({ shop, action: "suggest_topics", detail: `goal:${goal.slice(0, 60)}` });
    return json({ ok: true, topics: topics.map((t) => String(t).slice(0, 120)).slice(0, 5) });
  } catch {
    return json({ ok: false, error: "PARSE_FAILED", message: "Try again." }, { status: 502 });
  }
};
