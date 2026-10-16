import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { MAX_RULES_CHARS, setAgentRules } from "../lib/agents.server";
import { extractPdfText } from "../lib/pdf-text.server";

/**
 * POST /api/ai/agents/upload — attach working-rules PDF to an AI agent.
 * Admin-only (same guard as /app/admin). Multipart body: { agentId, file }.
 * Accepts PDF ≤ 5MB, extracts text (built-in extractor, no external deps),
 * caps at MAX_RULES_CHARS, stores on the agent. Never logs file contents.
 */
const MAX_PDF_BYTES = 5 * 1024 * 1024;

function bad(error: string, message: string, status = 400) {
  return json({ ok: false, error, message }, { status });
}

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
    return bad("BAD_FORM", "Could not read the upload. Try again.");
  }

  const agentId = String(form.get("agentId") ?? "").trim();
  if (!agentId) return bad("NO_AGENT", "Missing agent id.");

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return bad("NO_FILE", "Choose a PDF file to upload.");
  }
  const fileName = file.name || "rules.pdf";
  const isPdf =
    file.type === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return bad("NOT_PDF", "Only PDF files are accepted.");
  }
  if (file.size > MAX_PDF_BYTES) {
    return bad("TOO_LARGE", "PDF must be 5 MB or smaller.");
  }
  if (file.size === 0) {
    return bad("EMPTY_FILE", "The uploaded file is empty.");
  }

  let text: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    text = extractPdfText(buffer).replace(/[ \t]+\n/g, "\n").trim();
  } catch (e) {
    console.error("[adpilot agents] PDF extract failed:", e instanceof Error ? e.message : e);
    return bad("PARSE_FAILED", "Could not read text from this PDF.", 422);
  }
  if (!text) {
    return bad(
      "NO_TEXT",
      "No extractable text found in this PDF. Scanned/image PDFs need OCR first — export a text-based PDF instead.",
      422,
    );
  }

  const truncated = text.length > MAX_RULES_CHARS;
  try {
    await setAgentRules(agentId, text, fileName);
  } catch (e) {
    return bad("SAVE_FAILED", e instanceof Error ? e.message : "Could not save rules.", 500);
  }

  console.log(
    `[adpilot agents] rules PDF "${fileName}" attached to agent ${agentId} (${Math.min(text.length, MAX_RULES_CHARS)} chars${truncated ? ", truncated" : ""})`,
  );
  return json({
    ok: true,
    fileName,
    chars: Math.min(text.length, MAX_RULES_CHARS),
    truncated,
  });
};
