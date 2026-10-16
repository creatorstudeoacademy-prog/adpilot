/**
 * Server-only activity log for the admin AI report.
 * Every billable/AI action is recorded here: which shop, what action,
 * optional detail, and the fee charged (merchant spend = owner revenue).
 *
 * Fire-and-forget: logActivity never throws to its caller. Safe to call
 * from workers, routes, and background passes.
 */

import prisma from "../db.server";

export type ActivityAction =
  | "ai_generate"
  | "post_publish"
  | "post_schedule"
  | "ad_publish"
  | "audience_create"
  | "wallet_topup";

interface LogInput {
  shop: string;
  action: ActivityAction;
  detail?: string;
  feeCharged?: number;
}

// The generated Prisma client may lag behind schema.prisma in local dev
// (engines download is blocked); cast keeps tsc happy. Production
// regenerates the client at Docker build time, where activityLog exists.
interface ActivityLogDelegate {
  create: (args: {
    data: { shop: string; action: string; detail?: string; feeCharged: number };
  }) => Promise<unknown>;
}

function delegate(): ActivityLogDelegate | undefined {
  return (prisma as unknown as { activityLog?: ActivityLogDelegate }).activityLog;
}

/** Record an activity row. Never throws — logs to console on failure. */
export function logActivity(input: LogInput): void {
  const { shop, action, detail, feeCharged = 0 } = input;
  const d = delegate();
  if (!d) {
    console.warn("[adpilot activity] activityLog model unavailable, skipping log");
    return;
  }
  d.create({ data: { shop, action, detail, feeCharged } }).catch((e) => {
    console.error("[adpilot activity] log failed:", e);
  });
}
