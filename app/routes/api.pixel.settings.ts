import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const DEFAULTS = {
  dedupeEnabled: true,
  botFilterEnabled: true,
  piiScrubEnabled: true,
  staffFilterEnabled: false,
  staffIps: "",
  requireValueCurrency: true,
};

/**
 * GET /api/pixel/settings — the shop's pixel data-quality filter settings.
 * POST /api/pixel/settings — update them. Body (JSON): partial settings.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const existing = await prisma.pixelSettings.findUnique({ where: { shop: session.shop } });
  return json({
    ok: true,
    settings: {
      ...DEFAULTS,
      pixelId: existing?.pixelId ?? null,
      ...(existing
        ? {
            dedupeEnabled: existing.dedupeEnabled,
            botFilterEnabled: existing.botFilterEnabled,
            piiScrubEnabled: existing.piiScrubEnabled,
            staffFilterEnabled: existing.staffFilterEnabled,
            staffIps: existing.staffIps ?? "",
            requireValueCurrency: existing.requireValueCurrency,
          }
        : {}),
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  for (const key of [
    "dedupeEnabled",
    "botFilterEnabled",
    "piiScrubEnabled",
    "staffFilterEnabled",
    "requireValueCurrency",
  ]) {
    if (typeof body[key] === "boolean") data[key] = body[key];
  }
  if (typeof body.staffIps === "string") data.staffIps = body.staffIps.slice(0, 500) || null;
  if (typeof body.pixelId === "string") data.pixelId = body.pixelId.trim().slice(0, 32) || null;

  const settings = await prisma.pixelSettings.upsert({
    where: { shop },
    create: { shop, ...DEFAULTS, ...data },
    update: data,
  });
  return json({ ok: true, settings });
};
