import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { generateAdCreative } from "../lib/ai.server";
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";

/**
 * POST /api/ai/generate-creative
 * Body (JSON): { topic, objective, tone? }
 *
 * Generates ad headline + primary text + description via the ad_copy sector
 * (Muse agent when configured). Charged like a caption generation ($0.20)
 * unless the shop is a free shop.
 */
const FEE = 0.2;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { topic?: unknown; objective?: unknown; tone?: unknown; source?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const topic = String(body.topic ?? "").trim();
  const objective = String(body.objective ?? "TRAFFIC").trim() || "TRAFFIC";
  const tone = String(body.tone ?? "Professional").trim() || "Professional";
  // Funnel flows already charge the funnel fee — creative is included, no extra
  // charge. The waiver is NOT trust-on-client: it requires a FunnelGroup
  // created by this shop in the last 30 minutes (the funnel flow creates the
  // group right before generating creative).
  let funnelSource = String(body.source ?? "") === "funnel";
  if (funnelSource) {
    const recentFunnel = await prisma.funnelGroup.findFirst({
      where: { shop, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
      orderBy: { createdAt: "desc" },
    });
    if (!recentFunnel) funnelSource = false; // no recent funnel → charge normally
  }
  if (!topic) {
    return json({ ok: false, error: "Describe what the ad is about." }, { status: 400 });
  }

  // Charge first (skip for free shops and funnel flows — funnel fee covers creative), refund if AI fails.
  const free = isFreeShop(shop) || funnelSource;
  if (!free) {
    const wallet = await getWallet(shop);
    if (wallet.balance < FEE) {
      return json(
        { ok: false, error: "Insufficient wallet balance.", needTopup: true },
        { status: 402 },
      );
    }
    await deduct(shop, FEE, `Ad creative generation: ${topic.slice(0, 60)}`);
  }

  try {
    const result = await generateAdCreative({ topic, objective, tone });
    await prisma.activityLog.create({
      data: {
        shop,
        action: "ai_generate",
        detail: `ad creative via ${result.agent ?? result.provider}`,
      },
    });
    return json({
      ok: true,
      ...result,
      charged: free ? 0 : FEE,
      waived: free,
    });
  } catch (e) {
    if (!free) {
      await refund(shop, FEE, "Ad creative generation failed — refunded");
    }
    const message = e instanceof Error ? e.message : "AI generation failed.";
    return json({ ok: false, error: message }, { status: 500 });
  }
};
