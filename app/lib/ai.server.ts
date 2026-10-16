/**
 * Generic multi-provider AI layer for AdPilot (server-only).
 *
 * The owner can plug in ANY AI provider later without code changes — just env vars.
 * Providers are resolved from numbered slots (up to 5), tried in priority order,
 * with automatic fallback to the next provider on failure.
 *
 * ─── Env config ─────────────────────────────────────────────────────────────
 * AI_PROVIDER_ORDER = comma-separated slot names in priority order, e.g.
 *   AI_PROVIDER_ORDER="openai,groq,claude"
 *   (default: "openai")
 *
 * For each slot name X (uppercased, e.g. X=OPENAI):
 *   AI_<X>_TYPE      = "openai" | "anthropic"            (required)
 *   AI_<X>_KEY       = API key                           (required)
 *   AI_<X>_MODEL     = model id, e.g. gpt-4o-mini,
 *                      llama-3.3-70b-versatile, claude-haiku-4-5 (required)
 *   AI_<X>_BASE_URL  = openai-type only; custom endpoint so ANY
 *                      OpenAI-compatible API works (Groq, Together,
 *                      OpenRouter, DeepSeek, self-hosted, …).
 *                      Default: https://api.openai.com/v1
 *
 * Type "openai":    POST {baseUrl}/chat/completions, Bearer key,
 *                   body {model, messages, response_format:{type:"json_object"}}
 * Type "anthropic": POST https://api.anthropic.com/v1/messages,
 *                   x-api-key + anthropic-version: 2023-06-01,
 *                   body {model, max_tokens:1024, messages}
 *
 * Legacy fallback: a slot named "openai"/"anthropic" also honours
 * OPENAI_API_KEY/OPENAI_MODEL and ANTHROPIC_API_KEY/ANTHROPIC_MODEL.
 *
 * ADMIN: which shop sees the AI report dashboard:
 *   ADMIN_SHOP_DOMAIN = e.g. "lumen-demo.myshopify.com"
 *
 * See AI_SETUP.md for copy-paste examples (OpenAI, Groq, Claude).
 */

export type AIProviderType = "openai" | "anthropic";

export interface AIProviderConfig {
  /** lowercase slot name from AI_PROVIDER_ORDER, e.g. "groq" */
  name: string;
  type: AIProviderType;
  apiKey: string;
  model: string;
  /** openai-compatible base URL (anthropic ignores this) */
  baseUrl: string;
}

export interface CaptionInput {
  topic: string;
  platform: string; // facebook | instagram
  tone: string; // Professional | Funny | Casual
}

export interface CaptionResult {
  caption: string;
  hashtags: string[];
  /** slot name that served this generation, e.g. "groq" */
  provider: string;
}

const MAX_SLOTS = 5;
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `You are an expert social media copywriter for e-commerce brands.
Write scroll-stopping post captions that drive clicks and sales.
Rules:
- Caption: punchy, under 280 characters, 1-2 emojis max, clear call to action.
- Hashtags: 5-8 relevant lowercase hashtags WITHOUT the # prefix.
- Match the requested tone. For Instagram be a bit more playful; for Facebook be conversational.
- Never invent fake discounts, fake reviews, or specific prices.
Respond ONLY with JSON: {"caption": "...", "hashtags": ["...", "..."]}`;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** Resolve configured providers in priority order. Skips incomplete slots. */
export function resolveProviders(): AIProviderConfig[] {
  const order = (env("AI_PROVIDER_ORDER") || "openai")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_SLOTS);

  const providers: AIProviderConfig[] = [];
  const seen = new Set<string>();

  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const X = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

    let type = env(`AI_${X}_TYPE`).toLowerCase();
    // Legacy slots: infer type from the slot name when TYPE is unset.
    if (!type && (name === "openai" || name === "anthropic")) type = name;
    // Legacy fallback for the two first-party slots.
    let apiKey = env(`AI_${X}_KEY`);
    let model = env(`AI_${X}_MODEL`);
    if (!apiKey && name === "openai") apiKey = env("OPENAI_API_KEY");
    if (!model && name === "openai") model = env("OPENAI_MODEL");
    if (!apiKey && name === "anthropic") apiKey = env("ANTHROPIC_API_KEY");
    if (!model && name === "anthropic") model = env("ANTHROPIC_MODEL");

    if (!apiKey || !model) continue; // skip slots missing key/model
    if (type !== "openai" && type !== "anthropic") continue;

    const baseUrl = (
      env(`AI_${X}_BASE_URL`) || DEFAULT_OPENAI_BASE
    ).replace(/\/+$/, "");

    providers.push({ name, type, apiKey, model, baseUrl });
  }
  return providers;
}

/** Names of configured providers, in priority order. Empty = none configured. */
export function listProviders(): string[] {
  return resolveProviders().map((p) => p.name);
}

function buildUserPrompt(input: CaptionInput): string {
  const platformHint =
    input.platform === "instagram"
      ? "Platform: Instagram (hashtags matter, emojis welcome)."
      : "Platform: Facebook (conversational, community feel).";
  return `Write a caption for a social media post.
Topic / product: "${input.topic}"
${platformHint}
Tone: ${input.tone}
Respond ONLY with JSON: {"caption": "...", "hashtags": ["...", "..."]}`;
}

/** Extract the first JSON object from a possibly noisy model response. */
function extractJson(raw: string): { caption?: string; hashtags?: unknown } {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return JSON.");
  }
}

function normalizeResult(
  parsed: { caption?: string; hashtags?: unknown },
  provider: string,
): CaptionResult {
  const caption = String(parsed.caption ?? "").trim();
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags
        .map((h) => String(h).replace(/^#+/, "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 10)
    : [];
  if (!caption) throw new Error(`Provider "${provider}" returned an empty caption.`);
  return { caption, hashtags, provider };
}

async function callOpenAI(
  cfg: AIProviderConfig,
  input: CaptionInput,
): Promise<CaptionResult> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.9,
      max_tokens: 500,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return normalizeResult(extractJson(content), cfg.name);
}

async function callAnthropic(
  cfg: AIProviderConfig,
  input: CaptionInput,
): Promise<CaptionResult> {
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text =
    data.content?.find((b) => b.type === "text")?.text ?? "";
  return normalizeResult(extractJson(text), cfg.name);
}

/**
 * Generate a caption, trying providers in AI_PROVIDER_ORDER with fallback.
 * Throws Error("AI_NOT_CONFIGURED: ...") when no provider has key+model.
 * Throws Error("AI_ALL_PROVIDERS_FAILED: ...") when every provider fails.
 */
export async function generateCaption(input: CaptionInput): Promise<CaptionResult> {
  const providers = resolveProviders();
  if (providers.length === 0) {
    throw new Error(
      "AI_NOT_CONFIGURED: no AI provider configured. Set AI_PROVIDER_ORDER and AI_<NAME>_KEY / AI_<NAME>_MODEL env vars (see AI_SETUP.md).",
    );
  }

  const failures: string[] = [];
  for (const cfg of providers) {
    try {
      const result =
        cfg.type === "anthropic"
          ? await callAnthropic(cfg, input)
          : await callOpenAI(cfg, input);
      console.log(`[adpilot ai] caption generated via provider "${cfg.name}"`);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[adpilot ai] provider "${cfg.name}" failed: ${message}`);
      failures.push(`${cfg.name}: ${message}`);
    }
  }
  throw new Error(`AI_ALL_PROVIDERS_FAILED: ${failures.join(" | ")}`);
}
