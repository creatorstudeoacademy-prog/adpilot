import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GET /api/pixel/live-feed?pixelId=...&since=...
 *
 * Recent pixel events for the live animated feed (newest first, max 50).
 * `since` = ISO timestamp — returns only newer events (for polling).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const pixelId = url.searchParams.get("pixelId")?.trim() ?? "";
  const since = url.searchParams.get("since")?.trim() ?? "";
  if (!pixelId) {
    return json({ ok: false, message: "pixelId is required." }, { status: 400 });
  }

  const events = await prisma.pixelEvent.findMany({
    where: {
      shop,
      pixelId,
      ...(since ? { createdAt: { gt: new Date(since) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      eventName: true,
      source: true,
      url: true,
      value: true,
      currency: true,
      createdAt: true,
    },
  });

  return json({ ok: true, events });
};
