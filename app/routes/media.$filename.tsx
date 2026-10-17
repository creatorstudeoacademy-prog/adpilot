import type { LoaderFunctionArgs } from "@remix-run/node";
import { createReadStream, statSync } from "fs";
import { join, basename } from "path";

/**
 * GET /media/:filename — serves uploaded media + AI-generated images.
 * Public (no Shopify auth): Meta's crawlers fetch post media from here.
 * Filenames are strictly validated to prevent path traversal.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const raw = params.filename ?? "";
  // Only allow UUID-style filenames we created: hex + dashes + safe extension
  const m = /^([0-9a-f-]{36})\.([a-z0-9]+)$/.exec(raw);
  const ext = m?.[2] ?? "";
  const mime = MIME_BY_EXT[ext];
  if (!m || !mime) {
    throw new Response("Not found", { status: 404 });
  }
  // Try /data/media/ first (uploads), then /data/generated/ (AI images).
  const candidates = [
    join("/data", "media", basename(raw)),
    join("/data", "generated", basename(raw)),
  ];
  let filepath: string | null = null;
  let size = 0;
  for (const p of candidates) {
    try {
      size = statSync(p).size;
      filepath = p;
      break;
    } catch {
      // try next
    }
  }
  if (!filepath) {
    throw new Response("Not found", { status: 404 });
  }

  const stream = createReadStream(filepath);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
