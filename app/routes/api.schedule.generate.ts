import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import {
  chatWithProvider,
  resolveProvidersAsync,
  type ChatTurn,
} from "../lib/ai.server";
import { SCHEDULE_PACKAGES } from "../lib/pricing";

/**
 * POST /api/schedule/generate — AI-generates date-wise post drafts for a package.
 * Body: { packageId: "7d"|"15d"|"30d", goal: string, topic: string, startDate: ISO }
 * Returns { ok, posts: [{ date: ISO, content: string }] } (drafts, NOT saved).
 * No charge — charge happens on approve.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  void session.shop;

  let body: { packageId?: unknown; goal?: unknown; topic?: unknown; startDate?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const pkg = SCHEDULE_PACKAGES.find((p) => p.id === String(body.packageId ?? ""));
  const goal = String(body.goal ?? "").trim().slice(0, 500);
  const topic = String(body.topic ?? "").trim().slice(0, 500);
  const startDateRaw = String(body.startDate ?? "").trim();

  if (!pkg) {
    return json({ ok: false, error: "INVALID_PACKAGE", message: "Unknown package." }, { status: 400 });
  }
  if (!goal || !topic) {
    return json(
      { ok: false, error: "MISSING_INPUT", message: "Please tell us your goal and topic." },
      { status: 400 },
    );
  }
  const start = new Date(startDateRaw);
  if (isNaN(start.getTime())) {
    return json({ ok: false, error: "BAD_DATE", message: "Invalid start date." }, { status: 400 });
  }

  const providers = await resolveProvidersAsync();
  if (providers.length === 0) {
    return json(
      { ok: false, error: "AI_NOT_CONFIGURED", message: "AI is not configured." },
      { status: 503 },
    );
  }

  // Build date list: one post per day.
  const dates: string[] = [];
  for (let i = 0; i < pkg.posts; i++) {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(d.toISOString().slice(0, 10)); // YYYY-MM-DD
  }

  const systemPrompt = `You are a social media content writer for Facebook posts. Write engaging Facebook posts that are 3-5 sentences long (substantial, not one-liners). Each post must end with 3-5 relevant hashtags on a new line.

CRITICAL: Your ENTIRE response must be ONLY a valid JSON array of strings. No markdown, no code fences, no explanations, no text before or after. Just the raw JSON array like this:
["First post text here with several sentences.\n\n#Tag1 #Tag2 #Tag3","Second post text here.\n\n#Tag4 #Tag5"]`;

  const userPrompt = `Goal: ${goal}\nTopic: ${topic}\nWrite ${pkg.posts} different Facebook posts (one per day, dates: ${dates.join(", ")}). Vary the angle each day. Return ONLY the JSON array of ${pkg.posts} post strings.`;

  const turns: ChatTurn[] = [{ role: "user", content: userPrompt }];

  let raw = "";
  let lastError: unknown = null;
  for (const cfg of providers) {
    try {
      raw = await chatWithProvider(cfg, systemPrompt, turns);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!raw) {
    return json(
      { ok: false, error: "AI_FAILED", message: "Couldn't generate posts. Please try again." },
      { status: 502 },
    );
  }

  // Extract JSON array from response (strip markdown code fences first).
  let contents: string[] = [];
  try {
    let cleaned = raw.trim();
    // Remove ```json ... ``` or ``` ... ``` wrappers
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) cleaned = fence[1].trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    const parsed: unknown = JSON.parse(match ? match[0] : cleaned);
    if (!Array.isArray(parsed)) throw new Error("not array");
    contents = parsed.map((c) => String(c).slice(0, 2000));
    if (contents.length === 0) throw new Error("empty array");
  } catch {
    console.error("[schedule/generate] AI parse failed. Raw:", raw.slice(0, 500));
    return json(
      { ok: false, error: "AI_PARSE_FAILED", message: "AI returned an unexpected format. Please try again." },
      { status: 502 },
    );
  }

  // Pad or trim to exact count.
  while (contents.length < pkg.posts) contents.push(contents[contents.length - 1] ?? "");
  contents = contents.slice(0, pkg.posts);

  const posts = dates.map((date, i) => ({ date, content: contents[i] }));
  return json({ ok: true, posts });
};
