/**
 * DB-backed AI provider management (server-only).
 *
 * Lets the owner add ANY AI provider from the admin panel (/app/admin →
 * AI providers) without touching Railway env vars. API keys are stored
 * encrypted with AES-256-GCM (random IV per encryption).
 *
 * ─── Encryption key ─────────────────────────────────────────────────────────
 * The vault key is `AI_VAULT_KEY` when set, otherwise it FALLS BACK to
 * `SHOPIFY_API_SECRET`. The raw value is SHA-256 hashed to derive the
 * 32-byte AES key, so any string works as AI_VAULT_KEY.
 *
 * Set an explicit AI_VAULT_KEY in production (Railway → Variables): if the
 * fallback secret ever changes, previously encrypted provider keys become
 * undecryptable and those providers are skipped until their keys are
 * re-entered. Decryption failures never break generation — the provider is
 * skipped with an error log and the next provider is tried.
 *
 * Part of the portable AI module (see the portability note in
 * app/lib/ai.server.ts): no imports from app-specific code. The only
 * infrastructure import is the shared Prisma singleton (../db.server),
 * the same pattern app/lib/agents.server.ts uses. The Prisma AiProvider
 * model travels with this module.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import prisma from "../db.server";

export type DbProviderType = "openai" | "anthropic";

/** Default base URL for openai-type providers when none is stored. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Slot-name rules: lowercase, 1-32 chars, letters/digits/dashes. */
const NAME_RE = /^[a-z0-9-]{1,32}$/;

/**
 * Reserved names — never valid as a provider slot. Kept tiny on purpose:
 * overlapping an ENV slot name is ALLOWED (the DB provider wins — that's the
 * supported migration path from env vars to the admin panel), and DB
 * duplicates are rejected by the unique constraint with a clean error.
 */
const RESERVED_NAMES = new Set(["all", "none", "db", "env", "default"]);

export interface AiProviderRow {
  id: string;
  name: string;
  type: string;
  keyEncrypted: string;
  keyHint: string;
  model: string;
  baseUrl: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A DB provider with its key decrypted — SERVER ONLY, never send to the client. */
export interface DbProviderConfig {
  id: string;
  name: string;
  type: DbProviderType;
  /** Decrypted API key. Server-only. */
  apiKey: string;
  model: string;
  /** Normalized base URL (provider default applied for openai-type). */
  baseUrl: string;
  sortOrder: number;
  enabled: boolean;
  keyHint: string;
}

/** DB provider metadata for the admin UI — no key material included. */
export interface DbProviderMeta {
  id: string;
  name: string;
  type: DbProviderType;
  model: string;
  baseUrl: string;
  keyHint: string;
  sortOrder: number;
  enabled: boolean;
}

// The generated Prisma client may lag behind schema.prisma in local dev
// (engines download is blocked); cast keeps tsc happy. Production
// regenerates the client at Docker build time, where aiProvider exists.
interface AiProviderDelegate {
  findMany(args: unknown): Promise<AiProviderRow[]>;
  findUnique(args: unknown): Promise<AiProviderRow | null>;
  create(args: unknown): Promise<AiProviderRow>;
  update(args: unknown): Promise<AiProviderRow>;
  delete(args: unknown): Promise<AiProviderRow>;
  aggregate(args: unknown): Promise<{ _max: { sortOrder: number | null } }>;
}

function delegate(): AiProviderDelegate | undefined {
  return (prisma as unknown as { aiProvider?: AiProviderDelegate }).aiProvider;
}

function needDelegate(): AiProviderDelegate {
  const d = delegate();
  if (!d) throw new Error("AiProvider model not available yet — redeploy to apply migrations.");
  return d;
}

/** Derive the 32-byte AES key. Falls back to SHOPIFY_API_SECRET (see header). */
let vaultFallbackWarned = false;
function getVaultKey(): Buffer {
  const dedicated = (process.env.AI_VAULT_KEY ?? "").trim();
  const raw = dedicated || (process.env.SHOPIFY_API_SECRET ?? "").trim();
  if (!raw) {
    throw new Error(
      "Cannot encrypt provider keys: set AI_VAULT_KEY (or SHOPIFY_API_SECRET fallback) in env.",
    );
  }
  // The fallback couples AI/Meta token encryption to the Shopify secret: a
  // secret rotation orphans every encrypted key. Warn once so the owner sets
  // the dedicated AI_VAULT_KEY env var.
  if (!dedicated && !vaultFallbackWarned) {
    vaultFallbackWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[adpilot vault] AI_VAULT_KEY is not set — using SHOPIFY_API_SECRET fallback. " +
        "Set a dedicated AI_VAULT_KEY in Railway env vars to avoid orphaning encrypted keys on secret rotation.",
    );
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Encrypt an API key. Returns "iv:ciphertext:tag" (hex). Random IV each call. */
export function encryptKey(plain: string): string {
  const key = getVaultKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ciphertext.toString("hex")}:${tag.toString("hex")}`;
}

/** Decrypt a value produced by encryptKey. Throws on tamper or wrong vault key. */
export function decryptKey(stored: string): string {
  const key = getVaultKey();
  const [ivHex, ctHex, tagHex] = String(stored).split(":");
  if (!ivHex || !ctHex || !tagHex) throw new Error("Malformed encrypted provider key.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
  if (!plain) throw new Error("Decrypted provider key is empty.");
  return plain;
}

/** Normalize + validate a provider slot name. Throws on invalid/reserved. */
export function normalizeProviderName(raw: string): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid provider name "${raw}". Use 1-32 lowercase letters, digits, or dashes (e.g. "groq").`,
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`"${name}" is a reserved provider name — pick another.`);
  }
  return name;
}

function normalizeType(raw: string): DbProviderType {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t !== "openai" && t !== "anthropic") {
    throw new Error(`Invalid provider type "${raw}". Use "openai" or "anthropic".`);
  }
  return t;
}

function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const b = String(raw ?? "").trim().replace(/\/+$/, "");
  return b ? b : null;
}

function toConfig(row: AiProviderRow, apiKey: string): DbProviderConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as DbProviderType,
    apiKey,
    model: row.model,
    baseUrl:
      row.type === "anthropic"
        ? row.baseUrl ?? ""
        : row.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    keyHint: row.keyHint,
  };
}

function toMeta(row: AiProviderRow): DbProviderMeta {
  const c = toConfig(row, "");
  const { apiKey: _omit, ...meta } = c;
  return meta;
}

/**
 * Enabled DB providers, ordered by sortOrder asc (createdAt asc on ties).
 * Providers whose keys fail to decrypt are SKIPPED with an error log —
 * one bad row never breaks generation for the rest.
 */
export async function listDbProviders(): Promise<DbProviderConfig[]> {
  const d = needDelegate();
  const rows = await d.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const out: DbProviderConfig[] = [];
  for (const row of rows) {
    try {
      out.push(toConfig(row, decryptKey(row.keyEncrypted)));
    } catch (e) {
      console.error(
        `[adpilot ai-providers] skipping "${row.name}": cannot decrypt key (${e instanceof Error ? e.message : e}). Re-enter the key in /app/admin.`,
      );
    }
  }
  return out;
}

/** All DB providers (enabled or not) as UI-safe metadata — no key material. */
export async function listDbProviderMetas(): Promise<DbProviderMeta[]> {
  const d = needDelegate();
  const rows = await d.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toMeta);
}

export interface CreateProviderInput {
  name: string;
  type: string;
  key: string;
  model: string;
  baseUrl?: string | null;
  sortOrder?: number;
  enabled?: boolean;
}

/** Create a provider. Name duplicates (DB) are rejected; env-slot name
 *  overlap is allowed — the DB provider wins at resolution time (see
 *  resolveProvidersAsync in ai.server.ts). */
export async function createProvider(input: CreateProviderInput): Promise<DbProviderMeta> {
  const d = needDelegate();
  const name = normalizeProviderName(input.name);
  const type = normalizeType(input.type);
  const key = String(input.key ?? "").trim();
  if (!key) throw new Error("API key is required.");
  const model = String(input.model ?? "").trim();
  if (!model) throw new Error("Model is required.");

  const existing = await d.findUnique({ where: { name } });
  if (existing) throw new Error(`A provider named "${name}" already exists.`);

  let sortOrder = input.sortOrder;
  if (sortOrder === undefined || !Number.isFinite(sortOrder)) {
    const agg = await d.aggregate({ _max: { sortOrder: true } });
    sortOrder = (agg._max.sortOrder ?? -1) + 1; // append at the end
  }

  const row = await d.create({
    data: {
      name,
      type,
      keyEncrypted: encryptKey(key),
      keyHint: key.slice(-4),
      model,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      sortOrder: Math.trunc(sortOrder),
      enabled: input.enabled !== false,
    },
  });
  console.log(`[adpilot ai-providers] created provider "${name}" (${type})`);
  return toMeta(row);
}

export interface UpdateProviderInput {
  type?: string;
  /** New API key — re-encrypted only when a non-empty value is supplied. */
  key?: string;
  model?: string;
  baseUrl?: string | null;
  sortOrder?: number;
  enabled?: boolean;
}

/** Update a provider. The name is immutable (agents reference it by name —
 *  delete + recreate to rename). */
export async function updateProvider(id: string, patch: UpdateProviderInput): Promise<DbProviderMeta> {
  const d = needDelegate();
  const data: Record<string, unknown> = {};
  if (patch.type !== undefined) data.type = normalizeType(patch.type);
  if (patch.model !== undefined) {
    const model = String(patch.model).trim();
    if (!model) throw new Error("Model cannot be empty.");
    data.model = model;
  }
  if (patch.baseUrl !== undefined) data.baseUrl = normalizeBaseUrl(patch.baseUrl);
  if (patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder)) {
    data.sortOrder = Math.trunc(patch.sortOrder);
  }
  if (patch.enabled !== undefined) data.enabled = patch.enabled === true;
  const newKey = String(patch.key ?? "").trim();
  if (newKey) {
    data.keyEncrypted = encryptKey(newKey);
    data.keyHint = newKey.slice(-4);
  }
  if (Object.keys(data).length === 0) throw new Error("Nothing to update.");

  try {
    const row = await d.update({ where: { id }, data });
    console.log(`[adpilot ai-providers] updated provider "${row.name}"`);
    return toMeta(row);
  } catch (e) {
    throw new Error(`Provider not found (${String(e instanceof Error ? e.message : e).slice(0, 120)})`);
  }
}

/** Delete a provider. Agents referencing it by name gracefully fall back to
 *  the next provider/agent at generation time (see agents.server.ts). */
export async function deleteProvider(id: string): Promise<void> {
  const d = needDelegate();
  try {
    const row = await d.delete({ where: { id } });
    console.log(`[adpilot ai-providers] deleted provider "${row.name}"`);
  } catch {
    throw new Error("Provider not found.");
  }
}

/** Enable/disable a provider without touching its key. */
export async function setProviderEnabled(id: string, enabled: boolean): Promise<DbProviderMeta> {
  return updateProvider(id, { enabled });
}
