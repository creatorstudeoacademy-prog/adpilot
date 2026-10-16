# AdPilot AI Setup — plug in any AI provider, no code changes

AdPilot's AI caption generator uses a **generic provider system**. Add providers
two ways: the **admin panel** (easiest — no redeploy) or **env vars** (advanced).
Providers are tried in priority order, with automatic fallback to the next
provider if one fails.

## Managing providers from the admin panel (recommended)

`/app/admin` → **AI providers** (owner-only). No Railway changes, no redeploy —
providers take effect immediately.

**Add a provider:** fill in the form —
- **Name** — a short slot name, e.g. `groq` (lowercase letters, digits, dashes).
- **Type** — `OpenAI-compatible` (Groq, Together, OpenRouter, DeepSeek,
  self-hosted…) or `Anthropic`.
- **API key** — pasted once, encrypted before storage, never shown again
  (only the last 4 characters appear, as `••••1234`).
- **Model** — e.g. `llama-3.3-70b-versatile`, `claude-haiku-4-5`.
- **Base URL** — only for OpenAI-compatible endpoints
  (e.g. `https://api.groq.com/openai/v1`); leave empty for the default.
- **Enabled** — untick to pause a provider without deleting it.

**Edit / disable / delete:** each provider row has Edit (change type, model,
key, base URL — leave the key blank to keep the current one), Enable/Disable,
and Delete. Deleting is safe: agents using that provider automatically fall
back to the next provider.

**Priority order:** admin-panel providers are tried **first** (in list order),
then Railway env-var providers. A provider added here with the same name as
an env-var slot (e.g. `claude`) **overrides** the env one — that's the
supported way to migrate a provider from env vars into the panel.

**Badges:** `Admin panel` = managed here (editable). `Railway` = configured
via env vars (read-only here — edit in Railway → Variables → redeploy).

**Encryption note:** keys are encrypted with AES-256-GCM (random IV per key).
The vault key is `AI_VAULT_KEY` when set, otherwise it falls back to
`SHOPIFY_API_SECRET`. Set an explicit `AI_VAULT_KEY` in Railway Variables for
production: if the vault key ever changes, stored keys become undecryptable —
those providers are skipped (logged) until you re-enter their keys. Nothing
breaks; generation falls through to the next provider.

## Env vars (advanced / alternative)

Everything below still works exactly as before — env-var providers are simply
tried *after* admin-panel providers. Useful for the first bootstrap provider
or when you prefer config-as-code.

| Var | Meaning |
|---|---|
| `AI_PROVIDER_ORDER` | Comma-separated slot names in priority order, e.g. `"openai,groq,claude"`. Default: `"openai"`. Max 5 slots. |
| `AI_<X>_TYPE` | `openai` or `anthropic` (required). X = slot name uppercased. |
| `AI_<X>_KEY` | API key (required) |
| `AI_<X>_MODEL` | Model id (required) |
| `AI_<X>_BASE_URL` | **openai-type only.** Custom endpoint so ANY OpenAI-compatible API works (Groq, Together, OpenRouter, DeepSeek, self-hosted…). Default: `https://api.openai.com/v1` |
| `AI_VAULT_KEY` | **(recommended)** Vault key for encrypting admin-panel provider keys. Falls back to `SHOPIFY_API_SECRET` when unset. |

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

## All supported provider setups (copy-paste)

Every setup below is 4–5 env vars: `TYPE` + `KEY` + `MODEL` (+ `BASE_URL` for
OpenAI-compatible endpoints), then add the slot name to `AI_PROVIDER_ORDER`.

**OpenRouter** (one key, hundreds of models):

```bash
AI_PROVIDER_ORDER="openrouter"
AI_OPENROUTER_TYPE="openai"
AI_OPENROUTER_KEY="sk-or-…"
AI_OPENROUTER_MODEL="meta-llama/llama-3.3-70b-instruct"
AI_OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
```

**DeepSeek** (cheap, OpenAI-compatible):

```bash
AI_PROVIDER_ORDER="deepseek"
AI_DEEPSEEK_TYPE="openai"
AI_DEEPSEEK_KEY="sk-…"
AI_DEEPSEEK_MODEL="deepseek-chat"
AI_DEEPSEEK_BASE_URL="https://api.deepseek.com/v1"
```

**Azure OpenAI** — `MODEL` is your **deployment name**, `BASE_URL` is your
resource endpoint + deployment path. Some Azure setups require `?api-version=`
appended to the base URL; if calls fail with 404, add it:

```bash
AI_PROVIDER_ORDER="azure"
AI_AZURE_TYPE="openai"
AI_AZURE_KEY="…"
AI_AZURE_MODEL="my-gpt4o-mini-deployment"
AI_AZURE_BASE_URL="https://<resource>.openai.azure.com/openai/deployments/<deployment>?api-version=2024-10-01-preview"
```

**Self-hosted** (Ollama / vLLM / LM Studio — must be reachable over HTTPS):

```bash
AI_PROVIDER_ORDER="local"
AI_LOCAL_TYPE="openai"
AI_LOCAL_KEY="ollama"
AI_LOCAL_MODEL="llama3.3"
AI_LOCAL_BASE_URL="https://my-server.com/v1"
```

> **Not supported** by the env-key model: **AWS Bedrock** (it uses
> request-signing auth instead of API keys) and **OAuth-only AI services**
> (they need a browser consent flow, not a static key). Everything above that
> accepts a static API key works.

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

> Providers can now be added/edited/enabled/disabled from the dashboard itself
> (see "Managing providers from the admin panel" above). Per-skill
> enable/disable and fees are still managed via `app/lib/pricing.ts`.

## Pricing

`AI_GENERATION_FEE` in `app/lib/pricing.ts` (default **$0.20** per generation,
deducted from the merchant's wallet). Typical provider cost per caption is
~$0.01–0.03, so the margin funds the feature.

---

## AI Agents layer (Phase 1b)

An **AI agent** = a named worker with:
1. **Provider ref** — which AI serves it (must match a slot name in `AI_PROVIDER_ORDER`, e.g. `openai`, `groq`, `claude`).
2. **Sectors** — which skills it handles: `caption`, `hashtag`, `ad_copy`, `audience`, or `all`. Comma-separated, e.g. `caption,hashtag`.
3. **Working rules** — text extracted from a PDF you upload (cap 20,000 chars), prepended to every prompt as *"Follow these working rules: …"*.

### Routing & fallback

`generateForSector(sector, …)` (in `app/lib/agents.server.ts`):
- Finds **enabled** agents whose sectors include the sector (or `all`), ordered by **priority ascending** (lower = tried first).
- Each agent calls **its own provider** with its rules injected into the system prompt.
- If an agent's provider fails (or isn't configured), the **next agent** is tried automatically.
- All fail → `AI_ALL_AGENTS_FAILED`. No agents cover the sector → the caption generator falls back to plain provider order (backward compatible — the app works before you create any agent).

### Managing agents

`/app/admin` → **AI Agents** (owner-only, same `ADMIN_SHOP_DOMAIN` guard):
- **Create**: name, provider (dropdown of configured providers), sectors checkboxes (incl. "All sectors"), priority, enabled.
- **Rules PDF**: per-agent upload (PDF ≤ 5 MB) — text is extracted server-side and stored on the agent; the filename is shown once attached.
- **Delete** agents you no longer need.

Programmatic access lives in `app/lib/agents.server.ts`: `listAgents`, `getAgentsForSector`, `generateForSector`, `createAgent`, `setAgentRules`, `deleteAgent` — all take plain arguments, no app imports (portable module).

### The 3 flexible topologies

**1. One agent → all sectors** (simplest start)
- Agent "Main" — provider `openai`, sectors `all`, priority 0, + your rules PDF.
- Every generation flows through it.

**2. Two agents → all sectors** (priority + fallback)
- Agent "Primary" — provider `openai`, sectors `all`, priority 0.
- Agent "Backup" — provider `groq`, sectors `all`, priority 1.
- If OpenAI errors or rate-limits, Groq automatically takes over. Zero downtime.

**3. Different agents per sector** (specialists)
- Agent "Caption Pro" — provider `claude`, sectors `caption,hashtag`, priority 0, + caption rules PDF.
- Agent "Ad Writer" — provider `openai`, sectors `ad_copy`, priority 0, + ad-copy rules PDF.
- Agent "Audience Scout" — provider `groq`, sectors `audience`, priority 0.
- Each sector gets the best model + its own rulebook. (Add a second agent on the same sector any time for fallback.)

### Writing a good rules PDF

Keep it short, imperative, and sector-specific. Plain text exports work best (Word/Google Docs → PDF). Example for a caption agent:

```
Caption Agent — Working Rules
1. Always end with a clear call to action ("Shop now", "Comment YES").
2. Never invent discounts, prices, or reviews — only use facts from the topic.
3. Keep captions under 200 characters; max 2 emojis.
4. Hashtags: 5-8, lowercase, no brand names of competitors.
5. Tone: friendly and confident, never pushy.
6. If the topic mentions a sale, say "limited time" without inventing an end date.
```

Upload it on the agent's row in `/app/admin` → **AI Agents**. The text is injected verbatim above the task prompt on every call.

---

## Main orchestrator agent

One agent can be flagged **Main agent** (`isMainAgent`). It implicitly covers
**ALL sectors** regardless of its `sectors` value, and is tried **after**
specialized agents.

**Routing order** in `generateForSector(sector)`:
1. Enabled, active, specialized (non-main) agents covering the sector — priority ascending, each tried in turn, fallback on failure.
2. The enabled main agent (handles the work itself — it has all skills).
3. No main agent → legacy provider-order path (backward compatible).

If several agents are flagged main, the **lowest priority wins** (the admin UI
shows all flagged mains; keep only one to avoid confusion).

**Example:**
- Agent "Boss" — main, provider `openai`, sectors `all`, priority 0.
  With no other agents, *everything* (captions, hashtags, ad copy, audiences)
  goes through Boss.
- You add "CaptionMaster" — specialized, provider `claude`, sectors
  `caption`, priority 0, + caption rules PDF.
  Now: **captions → CaptionMaster** (specialist first), **everything else →
  Boss** (main catches the rest). If CaptionMaster's provider fails, Boss
  takes the caption as fallback.

Multi-sector fan-out: `generateForSectors(["caption","hashtag"], …)` routes
each sector-part to its own specialized agent and returns per-sector results
(sequential, to avoid rate-limit spikes).

## Subscription rotation (monthly AI plans)

Agents carry an optional subscription window:
- `activeFrom` — agent becomes routable at this date (null = no restriction).
- `expiresAt` — agent stops receiving work after this date (null = no restriction).

Expired or not-yet-active agents are **silently skipped by routing** but stay
visible in `/app/admin` → **AI Agents** with a status badge:
`scheduled` (starts in future) · `active` · `expiring soon` (≤ 7 days left) ·
`expired`.

**Zero-downtime monthly rotation:**
1. Create the new agent (new month's key/provider) with `activeFrom` = the
   1st of next month, enabled. It shows `scheduled` until then.
2. Set the old agent's `expiresAt` = end of this month. It shows
   `expiring soon` during the last 7 days.
3. On the 1st, routing flips to the new agent automatically — no deploy,
   no downtime. Delete or disable the old agent whenever you like.

## Agent workload & per-app stats

`/app/admin` → **AI Agents** now includes:
- **Agent workload** — per agent: tasks today / last 30 days, success vs
  failed, last used (UTC). Sourced from `ActivityLog.agentName`.
- **App × agent breakdown** — one row per app (`ActivityLog.app`,
  default `"adpilot"`): which agents worked, task counts, revenue. Built for
  the central AI Hub — more apps appear as rows with zero schema change.
