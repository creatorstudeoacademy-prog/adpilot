import type { ActionFunctionArgs } from "@remix-run/node";
import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";

import { authenticate } from "../shopify.server";

/**
 * POST /api/upload-media
 * FormData: file (image or video)
 *
 * Uploads to Shopify Files via staged upload and returns the CDN URL.
 * Supports images (JPG/PNG/GIF) and videos (MP4).
 */
const MAX_SIZE = 100 * 1024 * 1024; // 100MB

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await unstable_parseMultipartFormData(
    request,
    unstable_createMemoryUploadHandler({ maxPartSize: MAX_SIZE }),
  );
  const file = formData.get("file") as File | null;
  if (!file || typeof file === "object" && !(file instanceof File)) {
    return json({ ok: false, error: "No file provided." }, { status: 400 });
  }
  if (file.size === 0) {
    return json({ ok: false, error: "File is empty." }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return json({ ok: false, error: "File too large (max 100MB)." }, { status: 400 });
  }

  const mime = file.type || "";
  const isVideo = mime.startsWith("video/");
  const isImage = mime.startsWith("image/");
  if (!isVideo && !isImage) {
    return json(
      { ok: false, error: "Only image or video files are supported." },
      { status: 400 },
    );
  }

  // 1. Create a staged upload.
  const stagedRes = await admin.graphql(
    `#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [
          {
            filename: (file as File).name || `upload.${isVideo ? "mp4" : "jpg"}`,
            mimeType: mime,
            httpMethod: "POST",
            resource: isVideo ? "VIDEO" : "IMAGE",
          },
        ],
      },
    },
  );
  const stagedJson = await stagedRes.json();
  const target = stagedJson?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const userErrors = stagedJson?.data?.stagedUploadsCreate?.userErrors ?? [];
  if (!target || userErrors.length > 0) {
    return json(
      { ok: false, error: userErrors[0]?.message || "Staged upload failed." },
      { status: 500 },
    );
  }

  // 2. Upload the file bytes to the staged URL.
  const uploadForm = new FormData();
  for (const p of target.parameters ?? []) {
    uploadForm.append(p.name, p.value);
  }
  uploadForm.append("file", file);
  const uploadRes = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!uploadRes.ok) {
    return json({ ok: false, error: "File upload failed." }, { status: 500 });
  }

  // 3. Create the file record in Shopify Files.
  const createRes = await admin.graphql(
    `#graphql
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { ... on GenericFile { id url } ... on MediaImage { id image { url } } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        files: [
          isVideo
            ? {
                contentType: "VIDEO",
                originalSource: target.resourceUrl,
              }
            : {
                contentType: "IMAGE",
                originalSource: target.resourceUrl,
              },
        ],
      },
    },
  );
  const createJson = await createRes.json();
  const created = createJson?.data?.fileCreate?.files?.[0];
  const createErrors = createJson?.data?.fileCreate?.userErrors ?? [];
  if (!created || createErrors.length > 0) {
    return json(
      { ok: false, error: createErrors[0]?.message || "File record creation failed." },
      { status: 500 },
    );
  }

  const url = created.url || created.image?.url;
  if (!url) {
    return json({ ok: false, error: "Could not get file URL." }, { status: 500 });
  }

  return json({ ok: true, url, type: isVideo ? "video" : "image" });
};
