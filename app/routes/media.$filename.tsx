import type { LoaderFunctionArgs } from "@remix-run/node";
import { createReadStream, statSync } from "fs";
import { join, basename } from "path";

/**
 * GET /media/:filename — serves AI-generated images from persistent storage.
 * Public (no Shopify auth): Meta's crawlers fetch post media from here.
 * Filenames are strictly validated to prevent path traversal.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const raw = params.filename ?? "";
  // Only allow UUID-style png filenames we created: hex + dashes + .png
  if (!/^[0-9a-f-]{36}\.png$/.test(raw)) {
    throw new Response("Not found", { status: 404 });
  }
  const filepath = join("/data", "generated", basename(raw));
  let size: number;
  try {
    size = statSync(filepath).size;
  } catch {
    throw new Response("Not found", { status: 404 });
  }

  const stream = createReadStream(filepath);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
