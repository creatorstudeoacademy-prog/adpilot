import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { generateWithProvider, getProviderByNameAsync } from "../lib/ai.server";
import { listAgents } from "../lib/agents.server";

/**
 * POST /api/admin/ai-test — live connection test for one AI agent.
 * Admin-only (same 404 guard as /app/admin). Body: { agentId }.
 *
 * Sends a tiny real generation through the agent's own provider with the
 * agent's working rules injected — proving the full chain works:
 * agent -> provider -> model -> response. No wallet charge (admin diagnostic).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const adminShop = (process.env.ADMIN_SHOP_DOMAIN ?? "").trim();
  if (!adminShop || session.shop !== adminShop) {
    throw new Response("Not found", { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(
      { ok: false, error: "BAD_FORM", message: "Could not read the request." },
      { status: 400 },
    );
  }

  const agentId = String(form.get("agentId") ?? "").trim();
  if (!agentId) {
    return json(
      { ok: false, error: "NO_AGENT", message: "Missing agent id." },
      { status: 400 },
    );
  }

  const agent = (await listAgents()).find((a) => a.id === agentId);
  if (!agent) {
    return json(
      { ok: false, error: "NO_AGENT", message: "Agent not found." },
      { status: 404 },
    );
  }

  const cfg = await getProviderByNameAsync(agent.providerName);
  if (!cfg) {
    return json(
      {
        ok: false,
        error: "NO_PROVIDER",
        message: `Provider "${agent.providerName}" is not configured. Add it in AI providers.`,
        agent: agent.name,
      },
      { status: 400 },
    );
  }

  const started = Date.now();
  try {
    const systemPrompt = agent.rulesText
      ? `Follow these working rules:\n${agent.rulesText}\n\nYou are running a connection test.`
      : "You are running a connection test for the AdPilot app.";
    const text = await generateWithProvider(
      cfg,
      systemPrompt,
      "Connection test. Reply with exactly: OK - connection live.",
    );
    return json({
      ok: true,
      agent: agent.name,
      provider: cfg.name,
      latencyMs: Date.now() - started,
      output: text.slice(0, 200),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Neutral wording: this panel is owner-only, technical detail is fine here.
    return json(
      {
        ok: false,
        error: "AI_FAILED",
        message: `Agent "${agent.name}" via "${cfg.name}" failed: ${message}`,
        agent: agent.name,
        provider: cfg.name,
      },
      { status: 502 },
    );
  }
};
