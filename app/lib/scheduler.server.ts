/**
 * Scheduled-post publishing worker (server-only).
 *
 * Every 60 seconds it finds ScheduledPosts with status "scheduled" whose
 * scheduledAt has passed, publishes each via the existing Meta publishing
 * helpers, and marks them "published" (or "failed" with the error message).
 *
 * The publish fee was already deducted at schedule time, so this worker never
 * charges again. Each post is claimed (status -> "publishing") before the Meta
 * API call so concurrent ticks can't double-publish (idempotent).
 */

import prisma from "../db.server";
import { publishToPlatforms } from "./meta.server";

export interface DuePassResult {
  published: number;
  failed: number;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Run one publishing pass over all due scheduled posts. */
export async function runDuePostsPass(): Promise<DuePassResult> {
  const result: DuePassResult = { published: 0, failed: 0 };
  const now = new Date();

  const due = await prisma.scheduledPost.findMany({
    where: { status: "scheduled", scheduledAt: { lte: now } },
    include: { socialAccount: true },
    orderBy: { scheduledAt: "asc" },
    take: 50,
  });

  for (const post of due) {
    // Claim the post so a concurrent tick can't publish it twice.
    const claimed = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "scheduled" },
      data: { status: "publishing" },
    });
    if (claimed.count === 0) continue; // another tick claimed it first

    try {
      await publishToPlatforms({
        accessToken: post.socialAccount.accessToken,
        pageId: post.socialAccount.pageId,
        instagramId: post.socialAccount.instagramId,
        content: post.content,
        mediaUrls: parseJsonArray(post.mediaUrls),
        mediaType: post.mediaType,
        platforms: parseJsonArray(post.platforms),
      });
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "published", publishedAt: new Date(), error: null },
      });
      result.published += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Publishing failed.";
      // Fee was already taken at schedule time — do not charge again.
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "failed", error: message },
      });
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Start the in-process 60s interval. Safe to call multiple times (hot reloads):
 * only the first call takes effect. Never call during build.
 */
export function startScheduledPostWorker(intervalMs = 60_000): void {
  const g = globalThis as unknown as { __adpilotWorkerStarted?: boolean };
  if (g.__adpilotWorkerStarted) return;
  g.__adpilotWorkerStarted = true;

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap passes
    running = true;
    try {
      const r = await runDuePostsPass();
      if (r.published > 0 || r.failed > 0) {
        console.log(
          `[adpilot scheduler] pass complete: ${r.published} published, ${r.failed} failed`,
        );
      }
    } catch (e) {
      console.error("[adpilot scheduler] pass error:", e);
    } finally {
      running = false;
    }
  };

  // First pass shortly after boot so posts that came due during downtime
  // publish quickly, then every 60s.
  setTimeout(tick, 10_000);
  const timer = setInterval(tick, intervalMs);
  // Don't keep the process alive solely for the worker.
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}
