import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";

import { authenticate } from "../shopify.server";
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import { AI_IMAGE_GENERATION_FEE } from "../lib/pricing";
import { generateImage, listProvidersAsync } from "../lib/ai.server";
import { logActivity } from "../lib/activity.server";

/**
 * POST /api/ai/generate-image — AI image generator for post media.
 * Body (JSON): { prompt }
 * Charges AI_IMAGE_GENERATION_FEE ($0.40) from the wallet, generates the
 * image, downloads it to persistent storage (/data/generated) and returns a
 * permanent public URL the merchant can use as post media.
 * Refunds the fee if generation fails (merchant got nothing).
 * Returns { ok, url, provider } or { ok:false, error, message }.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { prompt?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const prompt = String(body.prompt ?? "").trim();

  if (!prompt) {
    return json(
      { ok: false, error: "EMPTY_PROMPT", message: "Describe the image you want." },
      { status: 400 },
    );
  }
  if (prompt.length > 1000) {
    return json(
      { ok: false, error: "PROMPT_TOO_LONG", message: "Keep the image description under 1000 characters." },
      { status: 400 },
    );
  }

  // Fail fast (no charge) when no provider is configured.
  if ((await listProvidersAsync()).length === 0) {
    return json(
      {
        ok: false,
        error: "AI_NOT_CONFIGURED",
        message:
          "AI is not configured yet. The store owner needs to add an OpenAI-compatible image provider (see AI_SETUP.md).",
      },
      { status: 503 },
    );
  }

  // Wallet check + deduct BEFORE calling the AI (same pattern as caption).
  const wallet = await getWallet(shop);
  if (!isFreeShop(shop) && wallet.balance < AI_IMAGE_GENERATION_FEE) {
    return json(
      {
        ok: false,
        error: "INSUFFICIENT_WALLET",
        message: `Insufficient wallet balance ($${wallet.balance.toFixed(2)}). Image generation costs $${AI_IMAGE_GENERATION_FEE.toFixed(2)} — please top up.`,
      },
      { status: 402 },
    );
  }
  await deduct(shop, AI_IMAGE_GENERATION_FEE, "AI image generation", undefined);

  try {
    const result = await generateImage(prompt);

    // Download to persistent storage — provider URLs are temporary.
    const dir = join("/data", "generated");
    await mkdir(dir, { recursive: true });
    const filename = `${randomUUID()}.png`;
    const filepath = join(dir, filename);

    const imgRes = await fetch(result.imageUrl);
    if (!imgRes.ok || !imgRes.body) {
      throw new Error(`Could not download generated image (${imgRes.status})`);
    }
    await pipeline(imgRes.body as unknown as NodeJS.ReadableStream, createWriteStream(filepath));

    const appUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
    const url = `${appUrl}/media/${filename}`;

    logActivity({
      shop,
      action: "ai_generate",
      detail: `provider:${result.provider} prompt:${prompt.slice(0, 80)}`,
      feeCharged: isFreeShop(shop) ? 0 : AI_IMAGE_GENERATION_FEE,
    });
    return json({ ok: true, url, provider: result.provider });
  } catch (e) {
    // Merchant got nothing — refund the generation fee.
    await refund(shop, AI_IMAGE_GENERATION_FEE, "Refund: AI image generation failed", undefined);
    const message = e instanceof Error ? e.message : "AI image generation failed.";
    console.error("[adpilot ai] image generation failed:", message);
    logActivity({
      shop,
      action: "ai_generate",
      detail: `failed: ${message.slice(0, 140)}`,
      feeCharged: 0,
    });
    return json({ ok: false, error: "AI_FAILED", message }, { status: 502 });
  }
};
