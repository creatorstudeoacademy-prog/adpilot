import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";

import prisma from "../db.server";

const BOT_PATTERNS = [
  /bot/i,
  /crawl/i,
  /spider/i,
  /headless/i,
  /lighthouse/i,
  /pingdom/i,
  /uptimerobot/i,
];

/**
 * POST /api/pixel/collect — receive a browser pixel event from the
 * AdPilot web pixel extension, apply the shop's data-quality filters,
 * and store it for the live event feed.
 *
 * This endpoint is called from the storefront (no Shopify auth — the
 * payload carries a shop identifier). Filters applied:
 * - botFilter: drop known bot/crawler user agents
 * - staffFilter: drop events from configured staff IPs
 * - piiScrub: strip anything that looks like an email/phone from the URL
 * - requireValueCurrency: drop purchase-ish events missing value/currency
 * - dedupe: drop if the same eventId arrived in the last 60s
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  let body: {
    shop?: unknown;
    pixelId?: unknown;
    eventName?: unknown;
    eventId?: unknown;
    url?: unknown;
    value?: unknown;
    currency?: unknown;
    contentIds?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false }, { status: 400 });
  }

  const shop = String(body.shop ?? "").trim();
  const pixelId = String(body.pixelId ?? "").trim();
  const eventName = String(body.eventName ?? "").trim();
  if (!shop || !pixelId || !eventName) {
    return json({ ok: false }, { status: 400 });
  }

  const settings = await prisma.pixelSettings.findUnique({ where: { shop } });
  const eventId = String(body.eventId ?? "").trim() || null;
  const ua = request.headers.get("user-agent") ?? "";
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "";

  // Filter: bots.
  if (settings?.botFilterEnabled !== false && BOT_PATTERNS.some((re) => re.test(ua))) {
    return json({ ok: true, filtered: "bot" });
  }
  // Filter: staff IPs.
  if (settings?.staffFilterEnabled && settings.staffIps) {
    const staffIps = settings.staffIps.split(",").map((x) => x.trim()).filter(Boolean);
    if (ip && staffIps.includes(ip)) {
      return json({ ok: true, filtered: "staff" });
    }
  }
  // Filter: dedupe (same eventId within 60s — browser+server double-fire).
  if (settings?.dedupeEnabled !== false && eventId) {
    const recent = await prisma.pixelEvent.findFirst({
      where: {
        shop,
        pixelId,
        eventId,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
      select: { id: true },
    });
    if (recent) {
      return json({ ok: true, filtered: "duplicate" });
    }
  }

  // Scrub PII from URL (emails, phone-like params).
  let url = String(body.url ?? "").slice(0, 500) || null;
  if (settings?.piiScrubEnabled !== false && url) {
    url = url
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]")
      .replace(/(\?|&)(phone|tel|email)=[^&]*/gi, "$1$2=[redacted]");
  }

  const value = body.value != null ? parseFloat(String(body.value)) : null;
  const currency = String(body.currency ?? "").trim().toUpperCase().slice(0, 3) || null;

  // Filter: purchase-ish events must carry value+currency (else ROAS is garbage).
  const needsValue = ["purchase", "addtocart", "initiatecheckout"].includes(
    eventName.toLowerCase().replace(/[^a-z]/g, ""),
  );
  if (settings?.requireValueCurrency !== false && needsValue && (value == null || !currency)) {
    return json({ ok: true, filtered: "missing_value" });
  }

  let contentIds: string | null = null;
  if (Array.isArray(body.contentIds)) {
    contentIds = JSON.stringify(body.contentIds.map(String).slice(0, 20));
  }

  const event = await prisma.pixelEvent.create({
    data: {
      shop,
      pixelId,
      eventName,
      source: "browser",
      url,
      value: value != null && !Number.isNaN(value) ? value : null,
      currency,
      contentIds,
      eventId,
    },
  });

  // Keep the table lean: prune events older than 7 days (best-effort).
  prisma.pixelEvent
    .deleteMany({ where: { shop, createdAt: { lt: new Date(Date.now() - 7 * 864e5) } } })
    .catch(() => {});

  return json({ ok: true, id: event.id });
};
