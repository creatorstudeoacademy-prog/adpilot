/**
 * Generic multi-provider AI layer for AdPilot (server-only).
 *
 * PORTABILITY NOTE: this file, together with app/lib/agents.server.ts,
 * app/lib/activity.server.ts, app/lib/ai-sectors.ts, app/lib/pdf-text.server.ts
 * and the AiAgent/ActivityLog Prisma models, is a self-contained AI module
 * with ZERO imports from app-specific code (no routes, wallet, compose,
 * pricing, or shopify.server imports — callers pass shop/context as plain
 * arguments). It is deliberately written this way so the owner can later
 * extract it verbatim into a shared "AI Hub" package used by all of his
 * apps; keep it that way when editing.
 *
 * The owner can plug in ANY AI provider later without code changes — just env vars
 * or the admin panel (/app/admin → AI providers, stored encrypted in the DB).
 * Providers are resolved from numbered slots (up to 5), tried in priority order,
 * with automatic fallback to the next provider on failure.
 *
 * ─── Resolution order (async) ───────────────────────────────────────────────
 * DB providers added in the admin panel (enabled, sortOrder asc) are tried
 * FIRST, then env-var providers from AI_PROVIDER_ORDER. A DB provider whose
 * name matches an env slot wins — the env slot is skipped. See
 * resolveProvidersAsync() below. The synchronous resolveProviders() resolves
 * env-var providers only (kept for backward compatibility).
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
  /** awareness = engagement/brand building, sales = conversion-focused */
  objective?: string; // awareness | sales
}

export interface CaptionResult {
  caption: string;
  hashtags: string[];
  /** slot name that served this generation, e.g. "groq" */
  provider: string;
  /** agent name when routed via the agent layer (undefined on legacy path) */
  agent?: string;
}

import { listDbProviders, DEFAULT_OPENAI_BASE_URL } from "./ai-providers.server";

const MAX_SLOTS = 5;
const DEFAULT_OPENAI_BASE = DEFAULT_OPENAI_BASE_URL;
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

/** Resolve ENV-VAR providers in priority order. Skips incomplete slots.
 *  (Env only — use resolveProvidersAsync() for the merged DB + env list.) */
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

/** Names of ENV-VAR providers, in priority order. Empty = none configured.
 *  (Env only — use listProvidersAsync() for the merged DB + env list.) */
export function listProviders(): string[] {
  return resolveProviders().map((p) => p.name);
}

/**
 * Merged provider list: DB providers added in the admin panel (enabled,
 * sortOrder asc) FIRST, then env-var providers from AI_PROVIDER_ORDER.
 * A DB provider whose name matches an env slot wins — the env slot is
 * skipped. If the DB is unreachable the env list is used alone (logged).
 */
export async function resolveProvidersAsync(): Promise<AIProviderConfig[]> {
  let db: Awaited<ReturnType<typeof listDbProviders>> = [];
  try {
    db = await listDbProviders();
  } catch (e) {
    console.error(
      `[adpilot ai] DB providers unavailable, using env only: ${e instanceof Error ? e.message : e}`,
    );
  }
  const dbNames = new Set(db.map((p) => p.name));
  const merged: AIProviderConfig[] = db.map((p) => ({
    name: p.name,
    type: p.type,
    apiKey: p.apiKey,
    model: p.model,
    baseUrl: p.baseUrl,
  }));
  for (const p of resolveProviders()) {
    if (dbNames.has(p.name)) continue; // DB wins the name
    merged.push(p);
  }
  return merged;
}

/** Names of ALL configured providers (DB first, then env), in try-order. */
export async function listProvidersAsync(): Promise<string[]> {
  return (await resolveProvidersAsync()).map((p) => p.name);
}

function buildUserPrompt(input: CaptionInput): string {
  const platformHint =
    input.platform === "instagram"
      ? "Platform: Instagram (hashtags matter, emojis welcome)."
      : "Platform: Facebook (conversational, community feel).";
  const objectiveHint =
    input.objective === "sales"
      ? "Goal: SALES — write to convert. Strong call to action (shop now, limited offer), urgency, benefit-focused. End with a clear buying CTA."
      : "Goal: AWARENESS — write to engage. Storytelling, relatable hook, invite likes/comments/shares/follows. Soft CTA, no hard selling.";
  return `Write a caption for a social media post.
Topic / product: "${input.topic}"
${platformHint}
Tone: ${input.tone}
${objectiveHint}
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

async function callOpenAIText(
  cfg: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
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
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropicText(
  cfg: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
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
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}

/**
 * Generic provider call used by the agent layer (app/lib/agents.server.ts).
 * Returns the model's raw text — callers parse it themselves.
 * Never logs or returns the API key.
 */
export async function generateWithProvider(
  cfg: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const text =
    cfg.type === "anthropic"
      ? await callAnthropicText(cfg, systemPrompt, userPrompt)
      : await callOpenAIText(cfg, systemPrompt, userPrompt);
  if (!text.trim()) throw new Error(`Provider "${cfg.name}" returned empty text.`);
  return text;
}

/** Find an ENV-VAR provider by slot name (case-insensitive).
 *  (Env only — use getProviderByNameAsync() for the merged DB + env list.) */
export function getProviderByName(name: string): AIProviderConfig | undefined {
  const want = name.trim().toLowerCase();
  return resolveProviders().find((p) => p.name === want);
}

/** Find ANY configured provider (DB first, then env) by name (case-insensitive). */
export async function getProviderByNameAsync(
  name: string,
): Promise<AIProviderConfig | undefined> {
  const want = name.trim().toLowerCase();
  return (await resolveProvidersAsync()).find((p) => p.name === want);
}

async function callOpenAI(
  cfg: AIProviderConfig,
  input: CaptionInput,
): Promise<CaptionResult> {
  const content = await callOpenAIText(cfg, SYSTEM_PROMPT, buildUserPrompt(input));
  return normalizeResult(extractJson(content), cfg.name);
}

async function callAnthropic(
  cfg: AIProviderConfig,
  input: CaptionInput,
): Promise<CaptionResult> {
  const text = await callAnthropicText(cfg, SYSTEM_PROMPT, buildUserPrompt(input));
  return normalizeResult(extractJson(text), cfg.name);
}

/**
 * Generate a caption. Routes through the agent layer first
 * (app/lib/agents.server.ts): specialized agents for the "caption" sector
 * are tried in priority order, then the main orchestrator agent (which
 * covers all sectors). If NO agent exists at all, falls back to the legacy
 * provider-order behavior — so the existing UI keeps working before any
 * agent is created.
 * Throws Error("AI_NOT_CONFIGURED: ...") / Error("AI_ALL_PROVIDERS_FAILED: ...")
 * / Error("AI_ALL_AGENTS_FAILED: ...") as appropriate.
 */
export async function generateCaption(input: CaptionInput): Promise<CaptionResult> {
  // Dynamic import: agents.server.ts imports from this module, so a static
  // import would create a module cycle. The agent layer stays optional.
  const { getAgentsForSector, getMainAgent, generateForSector } = await import("./agents.server");
  const [specialized, main] = await Promise.all([
    getAgentsForSector("caption"),
    getMainAgent(),
  ]);
  if (specialized.length > 0 || main) {
    const { text, agent, provider } = await generateForSector("caption", {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(input),
    });
    const result = normalizeResult(extractJson(text), provider);
    console.log(`[adpilot ai] caption generated via agent "${agent}" (provider "${provider}")`);
    return { ...result, agent };
  }

  // Legacy path: no agents configured — try providers in merged order
  // (admin-panel DB providers first, then AI_PROVIDER_ORDER).
  const providers = await resolveProvidersAsync();
  if (providers.length === 0) {
    throw new Error(
      "AI_NOT_CONFIGURED: no AI provider configured. Add one in /app/admin → AI providers, or set AI_PROVIDER_ORDER and AI_<NAME>_KEY / AI_<NAME>_MODEL env vars (see AI_SETUP.md).",
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

const AD_CREATIVE_PROMPT = `You are an expert Facebook/Instagram ad copywriter for e-commerce brands.
Write high-converting ad copy.

STRICT RULES:
- NEVER ask for more information, NEVER say "I need more details", NEVER output placeholder text like "Missing product details".
- ALWAYS write actual ad copy, even if the topic is vague. Make reasonable assumptions for a general e-commerce store selling trending products.
- If the topic is a season/event (e.g. "Winter Sale", "Summer Collection"), write copy for that theme.
- If the topic mentions a product type, write copy for that product.
- Headline: punchy, under 60 characters, clear benefit or offer.
- Primary text: 1-3 sentences, conversational, clear call to action, 1-2 emojis max.
- Description: one short supporting line, under 100 characters.
- Match the requested tone and campaign objective.
- Never invent fake discounts, fake reviews, or specific prices.

CRITICAL OUTPUT FORMAT: You MUST respond with ONLY a valid JSON object, no other text before or after. No explanations, no markdown, no code blocks. Just the raw JSON:
{"headline": "...", "primaryText": "...", "description": "..."}`;

export interface AdCreativeInput {
  topic: string;
  objective: string;
  tone?: string;
}

export interface AdCreativeResult {
  headline: string;
  primaryText: string;
  description: string;
  provider: string;
  agent?: string;
}

/** Generate ad headline + primary text + description via the ad_copy sector. */
export async function generateAdCreative(
  input: AdCreativeInput,
): Promise<AdCreativeResult> {
  const { getAgentsForSector, getMainAgent, generateForSector } = await import(
    "./agents.server"
  );
  const [specialized, main] = await Promise.all([
    getAgentsForSector("ad_copy"),
    getMainAgent(),
  ]);
  const userPrompt =
    `Write Facebook/Instagram ad copy.\n` +
    `Campaign objective: ${input.objective}\n` +
    `Tone: ${input.tone ?? "Professional"}\n` +
    `What the ad is about: ${input.topic}`;
  if (specialized.length > 0 || main) {
    const { text, agent, provider } = await generateForSector("ad_copy", {
      systemPrompt: AD_CREATIVE_PROMPT,
      userPrompt,
    });
    const parsed = extractJson(text) as Partial<AdCreativeResult>;
    console.log(
      `[adpilot ai] ad creative generated via agent "${agent}" (provider "${provider}")`,
    );
    return {
      headline: String(parsed.headline ?? "").slice(0, 120),
      primaryText: String(parsed.primaryText ?? "").slice(0, 2000),
      description: String(parsed.description ?? "").slice(0, 200),
      provider,
      agent,
    };
  }

  const providers = await resolveProvidersAsync();
  if (providers.length === 0) {
    throw new Error(
      "AI_NOT_CONFIGURED: no AI provider configured. Add one in /app/admin → AI providers.",
    );
  }
  const failures: string[] = [];
  for (const cfg of providers) {
    try {
      const text =
        cfg.type === "anthropic"
          ? await callAnthropicText(cfg, AD_CREATIVE_PROMPT, userPrompt)
          : await callOpenAIText(cfg, AD_CREATIVE_PROMPT, userPrompt);
      const parsed = extractJson(text) as Partial<AdCreativeResult>;
      console.log(`[adpilot ai] ad creative generated via provider "${cfg.name}"`);
      return {
        headline: String(parsed.headline ?? "").slice(0, 120),
        primaryText: String(parsed.primaryText ?? "").slice(0, 2000),
        description: String(parsed.description ?? "").slice(0, 200),
        provider: cfg.name,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push(`${cfg.name}: ${message}`);
    }
  }
  throw new Error(`AI_ALL_PROVIDERS_FAILED: ${failures.join(" | ")}`);
}

export interface ImageResult {
  /** Direct (possibly temporary) URL of the generated image. */
  imageUrl: string;
  /** Provider slot name that served this generation. */
  provider: string;
}

async function callOpenAIImage(
  cfg: AIProviderConfig,
  prompt: string,
): Promise<string> {
  const imageModel = env("AI_IMAGE_MODEL") || "dall-e-3";
  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: imageModel,
      prompt,
      n: 1,
      size: "1024x1024",
      response_format: "url",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Image API error ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const url = data.data?.[0]?.url;
  if (!url) throw new Error("Image API returned no image URL");
  return url;
}

/**
 * Generate an image with the first OpenAI-compatible provider that supports
 * the /images/generations endpoint (e.g. OpenAI DALL-E). Anthropic-type
 * providers are skipped — they cannot generate images.
 * Set AI_IMAGE_MODEL to override the default "dall-e-3".
 */
export async function generateImage(prompt: string): Promise<ImageResult> {
  const providers = await resolveProvidersAsync();
  if (providers.length === 0) {
    throw new Error(
      "AI_NOT_CONFIGURED: no AI provider configured. Add an OpenAI-compatible provider for image generation (see AI_SETUP.md).",
    );
  }
  const failures: string[] = [];
  for (const cfg of providers) {
    if (cfg.type !== "openai") {
      failures.push(`${cfg.name}: image generation needs an OpenAI-compatible provider`);
      continue;
    }
    try {
      const imageUrl = await callOpenAIImage(cfg, prompt);
      console.log(`[adpilot ai] image generated via provider "${cfg.name}"`);
      return { imageUrl, provider: cfg.name };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[adpilot ai] image provider "${cfg.name}" failed: ${message}`);
      failures.push(`${cfg.name}: ${message}`);
    }
  }
  throw new Error(`AI_ALL_PROVIDERS_FAILED: ${failures.join(" | ")}`);
}
