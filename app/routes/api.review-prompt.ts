import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PROMPT_COPY: Record<string, { title: string; message: string }> = {
  first_campaign: {
    title: "🎉 You launched your first campaign!",
    message: "How was the experience? Your review helps other merchants discover AdPilot.",
  },
  winner_scaled: {
    title: "🚀 Your campaign is winning!",
    message: "AdPilot spotted a winner for you. Enjoying the results? Leave us a review!",
  },
  thirty_days: {
    title: "📅 30 days with AdPilot",
    message: "You've been with us a month! If AdPilot is helping your business, we'd love your review.",
  },
};

/**
 * GET /api/review-prompt — returns the next undismissed prompt, if any.
 * POST /api/review-prompt { trigger, dismissed } — dismiss a prompt.
 * Also auto-creates the thirty_days prompt when due.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Auto-create 30-day prompt.
  const firstSeen = await prisma.reviewPrompt.findFirst({
    where: { shop },
    orderBy: { shownAt: "asc" },
  });
  if (firstSeen) {
    const days = (Date.now() - firstSeen.shownAt.getTime()) / 86400000;
    if (days >= 30) {
      const exists = await prisma.reviewPrompt.findFirst({ where: { shop, trigger: "thirty_days" } });
      if (!exists) {
        await prisma.reviewPrompt.create({ data: { shop, trigger: "thirty_days" } });
      }
    }
  } else {
    // First visit — plant the seed row so we can measure 30 days later.
    await prisma.reviewPrompt.create({ data: { shop, trigger: "first_seen", dismissed: true } });
  }

  const prompt = await prisma.reviewPrompt.findFirst({
    where: { shop, dismissed: false, trigger: { not: "first_seen" } },
    orderBy: { shownAt: "desc" },
  });
  if (!prompt || !PROMPT_COPY[prompt.trigger]) return json({ ok: true, prompt: null });

  return json({
    ok: true,
    prompt: {
      trigger: prompt.trigger,
      ...PROMPT_COPY[prompt.trigger],
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  let body: { trigger?: string } = {};
  try {
    body = (await request.json()) as { trigger?: string };
  } catch {
    /* ignore */
  }
  if (body.trigger) {
    await prisma.reviewPrompt.updateMany({
      where: { shop, trigger: body.trigger },
      data: { dismissed: true },
    });
  }
  return json({ ok: true });
}
