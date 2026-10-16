# AdPilot AI Setup — plug in any AI provider, no code changes

AdPilot's AI caption generator uses a **generic provider system**. Providers are
resolved from env vars at runtime, tried in priority order, with automatic
fallback to the next provider if one fails.

## Env vars

| Var | Meaning |
|---|---|
| `AI_PROVIDER_ORDER` | Comma-separated slot names in priority order, e.g. `"openai,groq,claude"`. Default: `"openai"`. Max 5 slots. |
| `AI_<X>_TYPE` | `openai` or `anthropic` (required). X = slot name uppercased. |
| `AI_<X>_KEY` | API key (required) |
| `AI_<X>_MODEL` | Model id (required) |
| `AI_<X>_BASE_URL` | **openai-type only.** Custom endpoint so ANY OpenAI-compatible API works (Groq, Together, OpenRouter, DeepSeek, self-hosted…). Default: `https://api.openai.com/v1` |

A slot missing `KEY` or `MODEL` (or with an unknown `TYPE`) is skipped silently.
If no slot is configured, merchants see: *"AI is not configured yet."*
If every provider fails, the error is `AI_ALL_PROVIDERS_FAILED` and the
merchant's $0.20 is refunded automatically.

Which provider served each generation is logged in the admin report
(`ActivityLog.detail` → `provider:<name>`).

## Example 1 — OpenAI only (default)

```bash
AI_PROVIDER_ORDER="openai"
AI_OPENAI_TYPE="openai"
AI_OPENAI_KEY="sk-…"
AI_OPENAI_MODEL="gpt-4o-mini"
# AI_OPENAI_BASE_URL defaults to https://api.openai.com/v1
```

## Example 2 — Groq (fast + cheap, OpenAI-compatible)

Get a key at https://console.groq.com/keys

```bash
AI_PROVIDER_ORDER="groq"
AI_GROQ_TYPE="openai"
AI_GROQ_KEY="gsk_…"
AI_GROQ_MODEL="llama-3.3-70b-versatile"
AI_GROQ_BASE_URL="https://api.groq.com/openai/v1"
```

## Example 3 — Claude (Anthropic)

Get a key at https://console.anthropic.com/

```bash
AI_PROVIDER_ORDER="claude"
AI_CLAUDE_TYPE="anthropic"
AI_CLAUDE_KEY="sk-ant-…"
AI_CLAUDE_MODEL="claude-haiku-4-5"
# no BASE_URL needed — Anthropic uses its own endpoint
```

## Example 4 — fallback chain (recommended)

```bash
AI_PROVIDER_ORDER="groq,openai,claude"
AI_GROQ_TYPE="openai"
AI_GROQ_KEY="gsk_…"
AI_GROQ_MODEL="llama-3.3-70b-versatile"
AI_GROQ_BASE_URL="https://api.groq.com/openai/v1"
AI_OPENAI_TYPE="openai"
AI_OPENAI_KEY="sk-…"
AI_OPENAI_MODEL="gpt-4o-mini"
AI_CLAUDE_TYPE="anthropic"
AI_CLAUDE_KEY="sk-ant-…"
AI_CLAUDE_MODEL="claude-haiku-4-5"
```

Groq is tried first; if it errors (rate limit, outage), OpenAI is tried;
then Claude. The merchant never notices the failover.

## Example 5 — any OpenAI-compatible API (Together / OpenRouter / DeepSeek / self-hosted)

```bash
AI_PROVIDER_ORDER="together"
AI_TOGETHER_TYPE="openai"
AI_TOGETHER_KEY="…"
AI_TOGETHER_MODEL="meta-llama/Llama-3.3-70B-Instruct-Turbo"
AI_TOGETHER_BASE_URL="https://api.together.xyz/v1"
```

## Where to set these (Railway)

Railway dashboard → your AdPilot service → **Variables** → add each var →
**Redeploy**. The app reads them at runtime; no code change needed.

## Admin report

```bash
ADMIN_SHOP_DOMAIN="your-dev-store.myshopify.com"
```

Only this shop sees the **AI Report** nav item (`/app/admin`): AI generations,
posts/ads/audiences per day, active merchants, and revenue — plus an
**AI Providers** section (configured providers, priority order, per-provider
usage, recent failures) and **AI Skills** (fee per skill).

> **Future:** editing API keys and enabling/disabling skills from the dashboard
> itself. For now keys live in env vars (Railway → Variables → Redeploy) and
> fees in `app/lib/pricing.ts`.

## Pricing

`AI_GENERATION_FEE` in `app/lib/pricing.ts` (default **$0.20** per generation,
deducted from the merchant's wallet). Typical provider cost per caption is
~$0.01–0.03, so the margin funds the feature.
