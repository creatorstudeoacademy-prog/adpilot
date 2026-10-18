import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import {
  chatWithProvider,
  resolveProvidersAsync,
  type ChatTurn,
} from "../lib/ai.server";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/support/chat — AdPilot customer-support chatbot.
 * Body (JSON): { message: string, history?: [{ role: "user"|"assistant", content }] }
 *
 * Support chat is FREE (no wallet deduction) — it's customer care, not a
 * premium AI feature. Uses the first available AI provider (DB providers
 * first, then env slots) with the AdPilot support knowledge base.
 * Returns { ok, reply } or { ok:false, error, message }.
 */

const SUPPORT_SYSTEM_PROMPT = `You are the AdPilot support assistant, a friendly and helpful AI inside the AdPilot Shopify app. AdPilot helps Shopify merchants publish social media posts and run Meta (Facebook/Instagram) ad campaigns from one dashboard.

YOUR KNOWLEDGE BASE — AdPilot features and pricing (all USD, pay-as-you-go from wallet top-ups, no subscription):

SOCIAL POSTING:
- Compose page: write posts, add images/videos (JPG, PNG, GIF, MP4, MOV), pick a Facebook Page, publish now or schedule. Fee: $0.50 per published post.
- Scheduled page: view scheduled posts, they auto-publish on time.

AI FEATURES:
- "Write my caption" AI caption writer: $0.20 per generation.
- AI image generation: $0.40 per image.
- AI creative fill (ad text): $0.20.

ADS MANAGER:
- Connect Meta ad account on the Accounts page (Facebook Login or paste a User Token manually). Add Meta Pixel ID per ad account for conversion tracking.
- Campaign objectives and one-time publish fees: Awareness $2, Traffic $2.50, Engagement $2.50, Sales $3. Extra ad set +$1.50, extra creative +$1.
- Campaigns page: turn campaigns on/off, delete, and use Analyze for AI insights.
- Full Funnel: one-click 3-stage funnel (Awareness + Engagement + Sales) for $10.50 total.

AUDIENCES:
- Audience Manager: saved interest audiences $1 each, lookalike $1.50.
- AI auto-create audience: describe your objective and the AI builds targeting for $1.20.

WALLET:
- Top-up packs: $5, $10, $30, $90, $240. Fees are deducted automatically per action. Top up from the Wallet page.

ACCOUNTS & SETUP:
- Connect Facebook Page + ad account on the Accounts page. If Facebook Login shows an error, use "paste a User Token manually" with a token from Meta Graph API Explorer.
- Meta App Review approval is required by Meta before live ad publishing works; the app guides merchants through it.

SUPPORT CONTACT: support@creatorstudioacademy.com

RULES:
- LANGUAGE: Detect the user's language from their message and ALWAYS reply in that SAME language (English, Bangla, Spanish, French, Arabic, Hindi, etc. — any language). If they switch languages, switch with them.
- TONE: Be warm, friendly, and conversational — like a helpful friend, not a robot. Light emoji where natural. Greet warmly.
- Answer concisely in plain language (2-6 sentences unless a step-by-step is needed).
- For how-to questions, give numbered steps referencing the exact AdPilot page names (Accounts, Compose, Ads Manager, Audiences, Wallet).
- If asked about pricing, quote the exact fees above.
- If you don't know something, say so and point to support@creatorstudioacademy.com.
- Never invent features, fees, or policies. Never ask for passwords or tokens in chat.`;

const MAX_HISTORY_TURNS = 12;
const MAX_MESSAGE_LEN = 2000;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const { checkRateLimit, rateLimitMessage } = await import("../lib/rate-limit.server");
  const rl = await checkRateLimit(shop, "support_chat");
  if (!rl.ok) {
    return json({ ok: false, error: rateLimitMessage("support_chat", rl.limit) }, { status: 429 });
  }

  let body: { message?: unknown; history?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const message = String(body.message ?? "").trim().slice(0, MAX_MESSAGE_LEN);
  if (!message) {
    return json(
      { ok: false, error: "EMPTY_MESSAGE", message: "Please type a message." },
      { status: 400 },
    );
  }

  // Normalize history: keep only well-formed turns, cap length.
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: ChatTurn[] = [];
  for (const t of rawHistory.slice(-MAX_HISTORY_TURNS)) {
    if (
      t &&
      typeof t === "object" &&
      ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant") &&
      typeof (t as ChatTurn).content === "string"
    ) {
      history.push({
        role: (t as ChatTurn).role,
        content: (t as ChatTurn).content.slice(0, MAX_MESSAGE_LEN),
      });
    }
  }

  const providers = await resolveProvidersAsync();
  if (providers.length === 0) {
    return json(
      {
        ok: false,
        error: "AI_NOT_CONFIGURED",
        message:
          "The support assistant is not configured yet. Please contact support@creatorstudioacademy.com.",
      },
      { status: 503 },
    );
  }

  const turns: ChatTurn[] = [...history, { role: "user", content: message }];

  // Try providers in order (DB first, then env), fallback on failure.
  let lastError: unknown = null;
  for (const cfg of providers) {
    try {
      const reply = await chatWithProvider(cfg, SUPPORT_SYSTEM_PROMPT, turns);
      logActivity({ shop, action: "support_chat", detail: `Support chat reply via ${cfg.name}` });
      return json({ ok: true, reply: reply.trim() });
    } catch (e) {
      lastError = e;
    }
  }

  return json(
    {
      ok: false,
      error: "AI_FAILED",
      message:
        "Sorry, I couldn't generate a reply right now. Please try again or email support@creatorstudioacademy.com.",
    },
    { status: 502 },
  );
};
