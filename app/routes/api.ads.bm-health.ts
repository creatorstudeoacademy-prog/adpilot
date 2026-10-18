import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken } from "../lib/token-vault.server";

/**
 * POST /api/ads/bm-health
 * Body (JSON): { businessId } (optional — defaults to the active connected BM)
 *
 * Business Manager health check: verification status, ad accounts and their
 * statuses, pages, pixels — then AI analysis -> structured JSON
 * { score, verdict, strengths, weaknesses, recommendations }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { businessId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const tokenRecord = await prisma.metaUserToken.findFirst({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });
  if (!tokenRecord) {
    return json({ ok: false, message: "Connect Facebook first." }, { status: 400 });
  }

  let businessId = String(body.businessId ?? "").trim();
  let businessName = "";
  if (!businessId) {
    const active = await prisma.businessManager.findFirst({ where: { shop, isActive: true } });
    if (!active) {
      return json(
        { ok: false, message: "Connect a Business Manager first (Accounts page)." },
        { status: 400 },
      );
    }
    businessId = active.businessId;
    businessName = active.name;
  }

  const { checkRateLimit, rateLimitMessage } = await import("../lib/rate-limit.server");
  const rl = await checkRateLimit(shop, "analyze_campaign");
  if (!rl.ok) {
    return json({ ok: false, message: rateLimitMessage("analyze_campaign", rl.limit) }, { status: 429 });
  }

  const token = decryptToken(tokenRecord.accessToken);
  const g = async (path: string, fields: string) => {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${path}?fields=${fields}&limit=50&access_token=${token}`,
    );
    const data = (await res.json()) as { data?: any[]; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message ?? `Failed to load ${path}.`);
    return data.data ?? [];
  };

  try {
    const [biz, owned, client] = await Promise.all([
      g(businessId, "id,name,verification_status").then((d) => d[0] ?? {}),
      g(`${businessId}/owned_ad_accounts`, "id,name,account_status,amount_spent,currency"),
      g(`${businessId}/client_ad_accounts`, "id,name,account_status,amount_spent,currency"),
    ]);
    if (!businessName) businessName = biz.name ?? "Business Manager";

    const STATUS_LABEL: Record<number, string> = {
      1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW",
      8: "PENDING_SETTLEMENT", 9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE",
      101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED",
    };
    const accounts = [...owned, ...client].map((a: any) => ({
      id: String(a.id ?? "").replace("act_", ""),
      name: a.name ?? "Ad account",
      status: STATUS_LABEL[a.account_status] ?? `status_${a.account_status}`,
      spend: a.amount_spent != null ? parseFloat(a.amount_spent) / 100 : null,
      currency: a.currency ?? "USD",
    }));
    const disabled = accounts.filter((a) => a.status !== "ACTIVE");

    const systemPrompt = `You are a Meta Business Manager health analyst. Given a business portfolio's verification status and ad accounts, judge how healthy the setup is and what to fix.

Rules:
- Be specific: reference actual account names, statuses, spend.
- Flag real risks: unverified business, disabled accounts, no active accounts.
- Keep it concise: short bullet points, no fluff.
- Respond with ONLY a single JSON object, no markdown fences, no extra text. Use this exact shape:
{
  "score": <0-100 health score>,
  "verdict": "<one-sentence overall verdict>",
  "strengths": ["<what is healthy>", ...],
  "weaknesses": ["<what is wrong or risky>", ...],
  "recommendations": [
    {"title": "<short action title>", "detail": "<1-2 sentence explanation>", "priority": "high|medium|low"},
    ...
  ]
}`;

    const userPrompt =
      `Business Manager health check:\n` +
      `Name: ${businessName} (${businessId})\n` +
      `Verification status: ${biz.verification_status ?? "unknown"}\n` +
      `Ad accounts (${accounts.length}):\n` +
      (accounts.length > 0
        ? accounts.map((a) => `- ${a.name} (${a.id}): ${a.status}, spent ${a.spend != null ? a.spend.toFixed(2) : "n/a"} ${a.currency}`).join("\n")
        : "- none") +
      `\nDisabled / problem accounts: ${disabled.length}` +
      `\n\nIs this Business Manager healthy? What should the merchant fix?`;

    const { generateForSector, getAgentsForSector, getMainAgent } = await import(
      "../lib/agents.server"
    );
    const [specialized, main] = await Promise.all([getAgentsForSector("campaign"), getMainAgent()]);
    let text: string;
    if (specialized.length > 0 || main) {
      const r = await generateForSector("campaign", { systemPrompt, userPrompt });
      text = r.text;
    } else {
      const { generateWithProvider, resolveProvidersAsync } = await import("../lib/ai.server");
      const providers = await resolveProvidersAsync();
      if (providers.length === 0) throw new Error("AI not configured.");
      text = await generateWithProvider(providers[0], systemPrompt, userPrompt);
    }
    await prisma.activityLog.create({
      data: { shop, action: "bm_health_check", detail: `BM ${businessName} health analyzed` },
    });
    return json({
      ok: true,
      analysis: text.trim(),
      business: {
        id: businessId,
        name: businessName,
        verificationStatus: biz.verification_status ?? "unknown",
        accountCount: accounts.length,
        disabledCount: disabled.length,
        accounts,
      },
    });
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Health check failed." },
      { status: 500 },
    );
  }
};
