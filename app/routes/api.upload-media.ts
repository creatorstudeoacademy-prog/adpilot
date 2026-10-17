import type { ActionFunctionArgs } from "@remix-run/node";
import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import { authenticate } from "../shopify.server";

/**
 * POST /api/upload-media
 * FormData: file (image or video)
 *
 * Saves to the app's /data/media/ volume and returns a public URL.
 * Much simpler and more reliable than Shopify staged uploads.
 */
const MAX_SIZE = 20 * 1024 * 1024; // 20MB
const MEDIA_DIR = "/data/media";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  // WebP rejected: Meta ads API does not accept WebP.
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  // WebM rejected: Meta prefers MP4 for video ads.
};

const SUPPORTED_MSG =
  "Supported: JPG, PNG, GIF images; MP4, MOV videos. WebP and WebM are not supported by Meta ads.";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  let formData: FormData;
  try {
    formData = await unstable_parseMultipartFormData(
      request,
      unstable_createMemoryUploadHandler({ maxPartSize: MAX_SIZE }),
    );
  } catch (e) {
    return json(
      { ok: false, error: `Could not read upload: ${e instanceof Error ? e.message : "unknown"}` },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return json({ ok: false, error: "No file provided." }, { status: 400 });
  }
  const mime = file.type || "";
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    const friendly =
      mime === "image/webp"
        ? "WebP images are not supported by Meta ads. Please upload JPG or PNG."
        : mime === "video/webm"
          ? "WebM videos are not supported by Meta ads. Please upload MP4."
          : SUPPORTED_MSG;
    return json({ ok: false, error: friendly }, { status: 400 });
  }
  const isVideo = mime.startsWith("video/");
  if (file.size === 0) {
    return json({ ok: false, error: "File is empty." }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return json({ ok: false, error: "File too large (max 20MB)." }, { status: 400 });
  }

  const filename = `${randomUUID()}.${ext}`;

  try {
    await mkdir(MEDIA_DIR, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(join(MEDIA_DIR, filename), buffer);
  } catch (e) {
    return json(
      { ok: false, error: `Could not save file: ${e instanceof Error ? e.message : "unknown"}` },
      { status: 500 },
    );
  }

  // Public URL via the existing /media/:filename route.
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  const url = base ? `${base}/media/${filename}` : `/media/${filename}`;
  return json({ ok: true, url, type: isVideo ? "video" : "image", filename });
};
