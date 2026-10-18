/**
 * Server-only rate limiter for free AI endpoints (cost-abuse protection).
 *
 * Counts ActivityLog rows per shop + action in the last 24h. Free shops
 * (owner's own stores) are exempt. Returns 429-style signals; callers
 * decide the response.
 */

import prisma from "../db.server";
import { isFreeShop } from "./wallet.server";

/** Max free uses per shop per 24h. */
const DAILY_CAPS: Record<string, number> = {
  support_chat: 50,
  suggest_topics: 30,
  analyze_campaign: 20,
};

export async function checkRateLimit(
  shop: string,
  key: string,
): Promise<{ ok: boolean; remaining: number; limit: number }> {
  const limit = DAILY_CAPS[key] ?? 20;
  if (isFreeShop(shop)) return { ok: true, remaining: limit, limit };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let count = 0;
  try {
    count = await prisma.activityLog.count({
      where: { shop, action: key, createdAt: { gte: since } },
    });
  } catch {
    // If the log table is unavailable, fail open (don't block the feature).
    return { ok: true, remaining: limit, limit };
  }
  return { ok: count < limit, remaining: Math.max(0, limit - count), limit };
}

export function rateLimitMessage(key: string, limit: number): string {
  const label =
    key === "support_chat"
      ? "support messages"
      : key === "suggest_topics"
        ? "topic suggestions"
        : "campaign analyses";
  return `You've reached the free daily limit (${limit} ${label} per day). Please try again tomorrow.`;
}
