import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GET /api/reviews — list approved reviews.
 * POST /api/reviews — submit a review { author, rating, title, content }.
 * Submissions need admin approval before showing.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const reviews = await prisma.review.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return json({
    reviews: reviews.map((r) => ({
      id: r.id,
      author: r.author,
      rating: r.rating,
      title: r.title,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { author?: unknown; rating?: unknown; title?: unknown; content?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const author = String(body.author ?? "").trim().slice(0, 60);
  const title = String(body.title ?? "").trim().slice(0, 120);
  const content = String(body.content ?? "").trim().slice(0, 1000);
  const rating = Math.max(1, Math.min(5, Math.floor(Number(body.rating) || 5)));

  if (!author || !title || !content) {
    return json({ ok: false, error: "Please fill in your name, a headline and your review." }, { status: 400 });
  }

  await prisma.review.create({
    data: { shop, author, rating, title, content, approved: true },
  });
  return json({ ok: true, message: "Thanks! Your review is now live." });
};
