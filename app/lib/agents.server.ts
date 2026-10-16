/**
 * AI agent routing layer (server-only).
 *
 * An "AI agent" = a named worker with (a) a provider ref, (b) assigned
 * sectors, (c) working-rules text extracted from an uploaded PDF,
 * (d) optional subscription window (activeFrom/expiresAt), and
 * (e) an optional MAIN-orchestrator flag.
 *
 * Routing order in generateForSector(sector):
 *   1. Enabled, active, specialized (non-main) agents covering the sector,
 *      by priority ascending — each tried in turn, fallback on failure.
 *   2. The enabled main agent (it implicitly covers ALL sectors).
 *   3. Nothing → AI_NO_AGENTS (callers like generateCaption fall back to
 *      the legacy provider-order path, keeping backward compatibility).
 *
 * Expired or not-yet-active agents are silently skipped by routing but still
 * visible in the admin UI with a status badge.
 *
 * Part of the portable AI module (see the portability note at the top of
 * app/lib/ai.server.ts): ZERO imports from app-specific code. The Prisma
 * AiAgent model travels with it. Callers pass plain arguments; this module
 * never touches routes, wallet, or billing.
 */

import prisma from "../db.server";
import {
  generateWithProvider,
  getProviderByName,
  resolveProviders,
} from "./ai.server";
import { SECTORS } from "./ai-sectors";

// Re-export for callers that already import from here.
export { SECTORS };
export type { Sector } from "./ai-sectors";

/** Max chars of extracted PDF rules text stored per agent. */
export const MAX_RULES_CHARS = 20000;

/** "Expiring soon" threshold for the admin status badge. */
export const EXPIRING_SOON_DAYS = 7;

export interface AgentRow {
  id: string;
  name: string;
  providerName: string;
  sectors: string;
  rulesText: string | null;
  rulesFileName: string | null;
  priority: number;
  enabled: boolean;
  isMainAgent: boolean;
  activeFrom: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

// The generated Prisma client may lag behind schema.prisma in local dev
// (engines download is blocked); cast keeps tsc happy. Production
// regenerates the client at Docker build time, where aiAgent exists.
interface AiAgentDelegate {
  findMany: (args?: {
    orderBy?: { priority: "asc" };
  }) => Promise<AgentRow[]>;
  create: (args: {
    data: {
      name: string;
      providerName: string;
      sectors: string;
      priority: number;
      enabled: boolean;
      isMainAgent: boolean;
      activeFrom: Date | null;
      expiresAt: Date | null;
    };
  }) => Promise<AgentRow>;
  update: (args: {
    where: { id: string };
    data: { rulesText: string; rulesFileName: string };
  }) => Promise<unknown>;
  delete: (args: { where: { id: string } }) => Promise<unknown>;
}

function delegate(): AiAgentDelegate | undefined {
  return (prisma as unknown as { aiAgent?: AiAgentDelegate }).aiAgent;
}

function sectorMatches(agentSectors: string, sector: string): boolean {
  const parts = agentSectors
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.includes("all") || parts.includes(sector.toLowerCase());
}

/**
 * Whether an agent may receive work right now: enabled AND inside its
 * subscription window (null activeFrom/expiresAt = no restriction).
 */
export function isAgentActive(agent: Pick<AgentRow, "enabled" | "activeFrom" | "expiresAt">, now: Date = new Date()): boolean {
  if (!agent.enabled) return false;
  if (agent.activeFrom && agent.activeFrom > now) return false;
  if (agent.expiresAt && agent.expiresAt <= now) return false;
  return true;
}

export type AgentStatus = "scheduled" | "active" | "expiring_soon" | "expired";

/** Date-based lifecycle badge for the admin UI (independent of enabled). */
export function getAgentStatus(
  agent: Pick<AgentRow, "activeFrom" | "expiresAt">,
  now: Date = new Date(),
): AgentStatus {
  if (agent.expiresAt && agent.expiresAt <= now) return "expired";
  if (agent.activeFrom && agent.activeFrom > now) return "scheduled";
  if (
    agent.expiresAt &&
    agent.expiresAt.getTime() - now.getTime() <= EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000
  ) {
    return "expiring_soon";
  }
  return "active";
}

/** All agents, priority order. Empty when the model isn't available yet. */
export async function listAgents(): Promise<AgentRow[]> {
  const d = delegate();
  if (!d) return [];
  return d.findMany({ orderBy: { priority: "asc" } });
}

/**
 * Active, specialized (non-main) agents covering a sector ("all" matches
 * everything), ordered by priority ascending (lower = tried first).
 */
export async function getAgentsForSector(sector: string): Promise<AgentRow[]> {
  const agents = await listAgents();
  const now = new Date();
  return agents.filter(
    (a) => !a.isMainAgent && isAgentActive(a, now) && sectorMatches(a.sectors, sector),
  );
}

/**
 * The enabled main orchestrator agent. If several are flagged, the lowest
 * priority wins (documented; the admin UI warns but doesn't block).
 */
export async function getMainAgent(): Promise<AgentRow | undefined> {
  const agents = await listAgents();
  const now = new Date();
  const mains = agents.filter((a) => a.isMainAgent && isAgentActive(a, now));
  return mains.sort((a, b) => a.priority - b.priority)[0];
}

export interface SectorGeneration {
  /** model raw text — the caller parses it */
  text: string;
  agent: string;
  provider: string;
}

/**
 * Generate via the agent layer, in routing order:
 *   1. specialized agents covering the sector (priority asc, fallback each),
 *   2. the main agent (covers all sectors),
 *   3. AI_NO_AGENTS when neither exists.
 * Each agent calls ITS provider with its working rules prepended to the
 * system prompt. Never logs API keys.
 */
export async function generateForSector(
  sector: string,
  opts: { systemPrompt: string; userPrompt: string },
): Promise<SectorGeneration> {
  const specialized = await getAgentsForSector(sector);
  const main = await getMainAgent();
  const candidates = main ? [...specialized, main] : specialized;

  if (candidates.length === 0) {
    throw new Error(
      `AI_NO_AGENTS: no enabled, active agent covers sector "${sector}" (and no main agent). Create one in the admin AI Agents section.`,
    );
  }

  const failures: string[] = [];
  for (const agent of candidates) {
    const cfg = getProviderByName(agent.providerName);
    if (!cfg) {
      const msg = `provider "${agent.providerName}" is not configured (check AI_PROVIDER_ORDER / AI_<NAME>_KEY)`;
      console.error(`[adpilot agents] agent "${agent.name}" skipped: ${msg}`);
      failures.push(`${agent.name}: ${msg}`);
      continue;
    }
    const systemPrompt = agent.rulesText
      ? `Follow these working rules:\n${agent.rulesText}\n\n${opts.systemPrompt}`
      : opts.systemPrompt;
    try {
      const text = await generateWithProvider(cfg, systemPrompt, opts.userPrompt);
      console.log(
        `[adpilot agents] sector "${sector}" served by agent "${agent.name}"${agent.isMainAgent ? " (main)" : ""} (provider "${cfg.name}")`,
      );
      return { text, agent: agent.name, provider: cfg.name };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[adpilot agents] agent "${agent.name}" failed: ${message}`);
      failures.push(`${agent.name}: ${message}`);
    }
  }
  throw new Error(`AI_ALL_AGENTS_FAILED: ${failures.join(" | ")}`);
}

export interface MultiSectorResult {
  sector: string;
  text: string;
  agent: string;
  provider: string;
}

/**
 * Multi-sector fan-out: route each sector-part to its own specialized agent
 * ("divide work among themselves"). Runs sequentially to avoid provider
 * rate-limit spikes. Each entry resolves independently — one sector's
 * failure aborts the whole call (callers can catch per-sector instead).
 */
export async function generateForSectors(
  sectors: string[],
  opts: { systemPrompt: string; userPrompt: string },
): Promise<MultiSectorResult[]> {
  const results: MultiSectorResult[] = [];
  for (const sector of sectors) {
    const r = await generateForSector(sector, opts);
    results.push({ sector, ...r });
  }
  return results;
}

export interface CreateAgentInput {
  name: string;
  providerName: string;
  sectors: string; // comma-separated or "all"
  priority?: number;
  enabled?: boolean;
  isMainAgent?: boolean;
  activeFrom?: Date | null;
  expiresAt?: Date | null;
}

/** Validate + create an agent. Throws on invalid provider or sectors. */
export async function createAgent(input: CreateAgentInput): Promise<AgentRow> {
  const d = delegate();
  if (!d) throw new Error("AiAgent model not available yet — redeploy to apply migrations.");

  const name = input.name.trim();
  if (!name) throw new Error("Agent name is required.");
  const providerName = input.providerName.trim().toLowerCase();
  if (!getProviderByName(providerName)) {
    const known = resolveProviders().map((p) => p.name).join(", ") || "(none configured)";
    throw new Error(
      `Provider "${input.providerName}" is not configured. Configured providers: ${known}.`,
    );
  }
  const sectors = input.sectors
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (sectors.length === 0) throw new Error("Assign at least one sector.");
  const valid = new Set<string>([...SECTORS, "all"]);
  const bad = sectors.filter((s) => !valid.has(s));
  if (bad.length > 0) {
    throw new Error(`Unknown sector(s): ${bad.join(", ")}. Valid: ${[...SECTORS, "all"].join(", ")}.`);
  }
  if (input.activeFrom && input.expiresAt && input.activeFrom >= input.expiresAt) {
    throw new Error("activeFrom must be before expiresAt.");
  }

  return d.create({
    data: {
      name,
      providerName,
      sectors: sectors.join(","),
      priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
      enabled: input.enabled !== false,
      isMainAgent: input.isMainAgent === true,
      activeFrom: input.activeFrom ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

/** Store extracted PDF rules text on an agent (caps at MAX_RULES_CHARS). */
export async function setAgentRules(
  id: string,
  rulesText: string,
  rulesFileName: string,
): Promise<void> {
  const d = delegate();
  if (!d) throw new Error("AiAgent model not available yet — redeploy to apply migrations.");
  const capped = rulesText.slice(0, MAX_RULES_CHARS);
  await d.update({ where: { id }, data: { rulesText: capped, rulesFileName } });
}

/** Delete an agent. */
export async function deleteAgent(id: string): Promise<void> {
  const d = delegate();
  if (!d) throw new Error("AiAgent model not available yet — redeploy to apply migrations.");
  await d.delete({ where: { id } });
}
