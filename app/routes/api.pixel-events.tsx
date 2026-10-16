import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

/**
 * Receives fire-and-forget event beacons from the PixelPro storefront script.
 * No auth — the payload only contains event names and the shop domain, and
 * events are kept in memory (last 100 per shop) for the diagnostics page.
 */

interface PixelEvent {
  shop: string;
  event: string;
  pixel: string;
  page: string;
  timestamp: number;
}

const eventsByShop = new Map<string, PixelEvent[]>();
const MAX_EVENTS = 100;

export function getRecentEvents(shop: string): PixelEvent[] {
  return eventsByShop.get(shop) ?? [];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false }, { status: 405 });
  }
  try {
    const body = await request.json();
    const shop = String(body.shop ?? "").trim();
    const event = String(body.event ?? "").trim();
    const pixel = String(body.pixel ?? "").trim();
    if (!shop || !event || !pixel) {
      return json({ ok: false }, { status: 400 });
    }
    const entry: PixelEvent = {
      shop,
      event,
      pixel,
      page: String(body.page ?? ""),
      timestamp: Date.now(),
    };
    const list = eventsByShop.get(shop) ?? [];
    list.unshift(entry);
    eventsByShop.set(shop, list.slice(0, MAX_EVENTS));
    return json({ ok: true });
  } catch {
    return json({ ok: false }, { status: 400 });
  }
};
