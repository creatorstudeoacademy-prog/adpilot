import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/schedule/post — edit or delete a scheduled post.
 * Body: { id, action: "update" | "delete", content?, date? (YYYY-MM-DD) }
 * Only posts with status "scheduled" or "draft" can be changed.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { id?: unknown; action?: unknown; content?: unknown; date?: unknown; time?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const id = String(body.id ?? "").trim();
  const act = String(body.action ?? "").trim();
  if (!id || (act !== "update" && act !== "delete")) {
    return json({ ok: false, error: "BAD_INPUT", message: "Invalid request." }, { status: 400 });
  }

  const post = await prisma.scheduledPost.findFirst({ where: { id, shop } });
  if (!post) {
    return json({ ok: false, error: "NOT_FOUND", message: "Post not found." }, { status: 404 });
  }
  if (post.status !== "scheduled" && post.status !== "draft") {
    return json(
      { ok: false, error: "LOCKED", message: "Only scheduled or draft posts can be changed." },
      { status: 400 },
    );
  }

  if (act === "delete") {
    // Manual posts paid per-post at schedule time — refund it. Package posts
    // were covered by the bundle fee, so there is no per-post amount to return.
    if (!post.schedulePackageId && !post.lifetimePackageId) {
      const { refund } = await import("../lib/wallet.server");
      const { POST_PUBLISH_FEE } = await import("../lib/pricing");
      await refund(shop, POST_PUBLISH_FEE, `Refund: deleted scheduled post`, post.id);
    }
    await prisma.scheduledPost.delete({ where: { id } });
    logActivity({ shop, action: "schedule_post_deleted", detail: `Deleted scheduled post ${id.slice(-6)}` });
    return json({ ok: true });
  }

  // update
  const content = String(body.content ?? "").trim().slice(0, 2000);
  const dateRaw = String(body.date ?? "").trim().slice(0, 10);
  if (!content) {
    return json({ ok: false, error: "EMPTY", message: "Content can't be empty." }, { status: 400 });
  }
  const data: { content: string; scheduledAt?: Date } = { content };
  if (dateRaw) {
    const timeRaw = /^\d{2}:\d{2}$/.test(String(body.time ?? "")) ? String(body.time) : "09:00";
    const d = new Date(`${dateRaw}T${timeRaw}:00Z`);
    if (isNaN(d.getTime())) {
      return json({ ok: false, error: "BAD_DATE", message: "Invalid date." }, { status: 400 });
    }
    data.scheduledAt = d;
  }
  await prisma.scheduledPost.update({ where: { id }, data });
  logActivity({ shop, action: "schedule_post_updated", detail: `Edited scheduled post ${id.slice(-6)}` });
  return json({ ok: true });
};
