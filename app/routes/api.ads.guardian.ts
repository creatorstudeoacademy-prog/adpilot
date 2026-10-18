import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GET /api/ads/guardian — Guardian settings + recent log.
 * POST /api/ads/guardian — update settings { enabled, maxSpendNoPurchase, minRoas, minSpendForRoas, notifyOnly }.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await prisma.guardianSettings.findUnique({ where: { shop } });
  if (!settings) {
    settings = await prisma.guardianSettings.create({ data: { shop } });
  }
  const log = await prisma.guardianLog.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return json({
    ok: true,
    settings: {
      enabled: settings.enabled,
      maxSpendNoPurchase: settings.maxSpendNoPurchase,
      minRoas: settings.minRoas,
      minSpendForRoas: settings.minSpendForRoas,
      notifyOnly: settings.notifyOnly,
      currency: settings.currency,
    },
    log: log.map((l) => ({
      id: l.id,
      campaignName: l.campaignName,
      action: l.action,
      reason: l.reason,
      spend: l.spend,
      purchases: l.purchases,
      createdAt: l.createdAt.toISOString(),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, message: "Invalid input." }, { status: 400 });
  }

  const data = {
    enabled: body.enabled !== false,
    maxSpendNoPurchase: Math.max(5, Math.min(1000, Number(body.maxSpendNoPurchase) || 20)),
    minRoas: Math.max(0.1, Math.min(10, Number(body.minRoas) || 1)),
    minSpendForRoas: Math.max(10, Math.min(2000, Number(body.minSpendForRoas) || 30)),
    notifyOnly: body.notifyOnly === true,
  };

  await prisma.guardianSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  return json({ ok: true, message: "Budget Guardian settings saved." });
}
