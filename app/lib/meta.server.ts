/**
 * Server-only helpers for the Meta Graph API (Facebook + Instagram publishing).
 *
 * Docs:
 * - Page posts: https://developers.facebook.com/docs/pages-api/posts
 * - IG content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface PublishInput {
  accessToken: string;
  pageId: string;
  instagramId?: string | null;
  content: string;
  mediaUrls: string[];
  mediaType: string; // post | reel | video
  platforms: string[]; // facebook, instagram
}

interface GraphError {
  error?: { message?: string; code?: number };
}

async function graphFetch(
  path: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<any> {
  const body = new URLSearchParams({ access_token: accessToken, ...params });
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    body,
  });
  const data = (await res.json()) as GraphError & Record<string, any>;
  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message ?? `Meta API error (HTTP ${res.status})`,
    );
  }
  return data;
}

/** Publish a text/photo post or video to a Facebook Page. */
export async function publishFacebookPost(input: PublishInput): Promise<string> {
  const { accessToken, pageId, content, mediaUrls, mediaType } = input;

  // Video / reel upload.
  if ((mediaType === "video" || mediaType === "reel") && mediaUrls[0]) {
    const data = await graphFetch(`/${pageId}/videos`, accessToken, {
      file_url: mediaUrls[0],
      description: content,
    });
    return data.id as string;
  }

  // Photo post.
  if (mediaType === "post" && mediaUrls[0]) {
    const data = await graphFetch(`/${pageId}/photos`, accessToken, {
      url: mediaUrls[0],
      caption: content,
    });
    return data.id as string;
  }

  // Plain text post.
  const data = await graphFetch(`/${pageId}/feed`, accessToken, {
    message: content,
  });
  return data.id as string;
}

/** Publish via the Instagram Content Publishing API (2-step: container + publish). */
export async function publishInstagramPost(input: PublishInput): Promise<string> {
  const { accessToken, instagramId, content, mediaUrls, mediaType } = input;
  if (!instagramId) {
    throw new Error("No Instagram Business account linked to this Page.");
  }

  const isVideo = mediaType === "video" || mediaType === "reel";
  const mediaUrl = mediaUrls[0];
  if (!mediaUrl) {
    throw new Error("Instagram publishing requires a media URL.");
  }

  // Step 1: create the media container.
  const containerParams: Record<string, string> = isVideo
    ? {
        media_type: mediaType === "reel" ? "REELS" : "VIDEO",
        video_url: mediaUrl,
        caption: content,
      }
    : {
        image_url: mediaUrl,
        caption: content,
      };

  const container = await graphFetch(
    `/${instagramId}/media`,
    accessToken,
    containerParams,
  );
  const containerId = container.id as string;

  // Step 2: publish the container.
  const published = await graphFetch(
    `/${instagramId}/media_publish`,
    accessToken,
    { creation_id: containerId },
  );
  return published.id as string;
}

/** Publish to every requested platform. Throws on the first failure. */
export async function publishToPlatforms(input: PublishInput): Promise<string[]> {
  const ids: string[] = [];
  if (input.platforms.includes("facebook")) {
    ids.push(await publishFacebookPost(input));
  }
  if (input.platforms.includes("instagram")) {
    ids.push(await publishInstagramPost(input));
  }
  return ids;
}

/** Save a post to the DB for later publishing (used by the scheduler). */
export async function schedulePost(input: {
  prisma: any;
  shop: string;
  socialAccountId: string;
  content: string;
  mediaUrls: string[];
  mediaType: string;
  platforms: string[];
  scheduledAt: Date;
}) {
  return input.prisma.scheduledPost.create({
    data: {
      shop: input.shop,
      socialAccountId: input.socialAccountId,
      content: input.content,
      mediaUrls: JSON.stringify(input.mediaUrls),
      mediaType: input.mediaType,
      platforms: JSON.stringify(input.platforms),
      scheduledAt: input.scheduledAt,
      status: "scheduled",
    },
  });
}
