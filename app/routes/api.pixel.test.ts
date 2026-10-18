import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken } from "../lib/token-vault.server";

/**
 * POST /api/pixel/test — send a Meta Conversions API test event.
 * Body: { adAccountDbId }
 *
 * Verifies the saved pixel ID actually receives events. The merchant checks
 * Meta Events Manager > Data sources > [pixel] > Test events with the
 * returned test code.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { adAccountDbId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const adAccount = await prisma.adAccount.findFirst({
    where: { id: String(body.adAccountDbId ?? ""), shop },
  });
  if (!adAccount?.pixelId) {
    return json({ ok: false, error: "No pixel saved for this ad account." }, { status: 400 });
  }

  const testCode = `ADPILOT-${Date.now().toString(36).toUpperCase()}`;
  const token = decryptToken(adAccount.accessToken);
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${adAccount.pixelId}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: token,
          test_event_code: testCode,
          data: [
            {
              event_name: "PageView",
              event_time: Math.floor(Date.now() / 1000),
              event_source_url: "https://adpilot-test.local/",
              action_source: "website",
            },
          ],
        }),
      },
    );
    const data = (await res.json()) as { error?: { message?: string }; events_received?: number };
    if (!res.ok || data.error) {
      throw new Error(data.error?.message ?? `HTTP ${res.status}`);
    }
    return json({
      ok: true,
      testCode,
      message: `Test event sent to pixel ${adAccount.pixelId}. Open Meta Events Manager → Data sources → Test events and enter code ${testCode} to verify it arrived.`,
    });
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Test event failed." },
      { status: 500 },
    );
  }
};
