import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/schedule/fix-times
 * One-time repair: finds scheduled (not yet published) posts sharing the same
 * date+time and spreads them out in 30-min steps. Never charges.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const posts = await prisma.scheduledPost.findMany({
    where: { shop, status: "scheduled", scheduledAt: { not: null } },
    orderBy: { scheduledAt: "asc" },
  });

  const used = new Set<string>();
  let fixed = 0;

  for (const p of posts) {
    let dt = new Date(p.scheduledAt!);
    const key = () => dt.toISOString().slice(0, 16);
    if (!used.has(key())) {
      used.add(key());
      continue;
    }
    // Collision — push forward in 30-min steps.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      dt = new Date(dt.getTime() + 30 * 60 * 1000);
      if (!used.has(key())) {
        used.add(key());
        await prisma.scheduledPost.update({
          where: { id: p.id },
          data: { scheduledAt: dt },
        });
        fixed++;
        break;
      }
    }
  }

  if (fixed > 0) {
    logActivity({ shop, action: "schedule_times_fixed", detail: `${fixed} posts re-timed` });
  }
  return json({ ok: true, fixed, total: posts.length });
};
