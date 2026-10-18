import { decryptToken } from "./token-vault.server";

/**
 * Server-only helpers for the Meta Marketing API (ad accounts, campaigns, ads).
 *
 * Docs: https://developers.facebook.com/docs/marketing-api
 *
 * Note: ads_management / ads_read permissions require Meta App Review.
 * All functions throw user-friendly errors on API failure.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

async function marketingFetch(
  path: string,
  accessToken: string,
  params: Record<string, string>,
  method: "GET" | "POST" | "DELETE" = "POST",
): Promise<any> {
  // Tokens are encrypted at rest; legacy plaintext rows pass through.
  accessToken = decryptToken(accessToken);
  const url =
    method === "GET"
      ? `${GRAPH_BASE}${path}?${new URLSearchParams({ access_token: accessToken, ...params })}`
      : `${GRAPH_BASE}${path}`;
  const body =
    method === "POST"
      ? new URLSearchParams({ access_token: accessToken, ...params })
      : method === "DELETE"
        ? new URLSearchParams({ access_token: accessToken })
        : undefined;

  const res = await fetch(url, { method, body });
  const data = (await res.json()) as GraphError & Record<string, any>;
  if (!res.ok || data.error) {
    const err = data.error ?? {};
    const details = [
      err.message ?? `Meta API error (HTTP ${res.status})`,
      err.code ? `(code ${err.code})` : "",
      err.error_subcode ? `(subcode ${err.error_subcode})` : "",
      err.error_data ? JSON.stringify(err.error_data).slice(0, 300) : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.error(`[meta-ads] API error on ${method} ${path}:`, details);
    throw new Error(friendlyMetaError(details));
  }
  return data;
}

/** Turn raw Meta errors into user-friendly messages. */
function friendlyMetaError(message: string): string {
  if (/\(code 190\)|invalid.*token|token.*(expired|invalid)|session.*expired/i.test(message))
    return "TOKEN_EXPIRED: Your Facebook connection expired — reconnect it in Accounts, then try again.";
  if (/permission|authorized|scope/i.test(message))
    return "Meta denied this action. Your Meta app may need App Review approval for ads permissions (ads_management, ads_read).";
  if (/budget/i.test(message))
    return `Budget issue: ${message}`;
  if (/account.*(disabled|inactive|restricted)/i.test(message))
    return "This ad account is disabled or restricted in Meta Ads Manager.";
  return message;
}

/** True when the error means the Meta token expired (merchant must reconnect). */
export function isTokenExpiredError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.startsWith("TOKEN_EXPIRED:");
}

import { OBJECTIVE_MAP } from "./meta-ads";

/** List ad accounts the user can advertise on. */
export async function listAdAccounts(accessToken: string) {
  const data = await marketingFetch(
    "/me/adaccounts",
    accessToken,
    { fields: "id,name,currency,account_status" },
    "GET",
  );
  return (data.data ?? []) as Array<{
    id: string;
    name: string;
    currency: string;
    account_status: number;
  }>;
}

/** Create a campaign under an ad account. Returns the Meta campaign ID. */
export async function createCampaign(
  adAccountId: string,
  accessToken: string,
  name: string,
  objective: string,
): Promise<string> {
  accessToken = decryptToken(accessToken);
  const metaObjective = OBJECTIVE_MAP[objective] ?? OBJECTIVE_MAP.TRAFFIC;
  // Send as JSON with proper array type for special_ad_categories
  const url = `${GRAPH_BASE}/act_${adAccountId}/campaigns`;
  const body = {
    access_token: accessToken,
    name,
    objective: metaObjective,
    status: "PAUSED",
    special_ad_categories: [] as string[],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok || data.error) {
    const err = data.error ?? {};
    throw new Error(
      `Meta API error: ${err.message ?? `HTTP ${res.status}`} (code ${err.code ?? "?"})` +
        (err.error_subcode ? ` (subcode ${err.error_subcode})` : ""),
    );
  }
  return data.id as string;
}

/** Create an ad set with a daily budget (in account currency units, e.g. dollars). */
export async function createAdSet(
  adAccountId: string,
  accessToken: string,
  campaignId: string,
  name: string,
  dailyBudget: number,
  startDate?: Date | null,
  endDate?: Date | null,
  customTargeting?: Record<string, unknown>,
  objective?: string,
  pixelId?: string | null,
): Promise<string> {
  // Optimization goal must match the campaign objective.
  const metaObjective = OBJECTIVE_MAP[objective ?? ""] ?? "";
  let optimizationGoal = "REACH";
  let billingEvent = "IMPRESSIONS";
  if (metaObjective === "OUTCOME_TRAFFIC" || objective === "TRAFFIC") {
    optimizationGoal = "LINK_CLICKS";
  } else if (metaObjective === "OUTCOME_ENGAGEMENT" || objective === "ENGAGEMENT") {
    optimizationGoal = "POST_ENGAGEMENT";
  } else if (metaObjective === "OUTCOME_SALES" || objective === "SALES") {
    if (pixelId) {
      // Full conversion optimization with pixel.
      optimizationGoal = "OFFSITE_CONVERSIONS";
      billingEvent = "IMPRESSIONS";
    } else {
      // Safe default if no pixel configured.
      optimizationGoal = "LINK_CLICKS";
      billingEvent = "IMPRESSIONS";
    }
  }
  const params: Record<string, string> = {
    name,
    campaign_id: campaignId,
    daily_budget: String(Math.round(dailyBudget * 100)), // Meta expects cents
    billing_event: billingEvent,
    optimization_goal: optimizationGoal,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: JSON.stringify(
      customTargeting ?? {
        geo_locations: { countries: ["US"] },
        age_min: 18,
        age_max: 65,
      },
    ),
    status: "PAUSED",
  };
  if (startDate) params.start_time = startDate.toISOString();
  if (endDate) params.end_time = endDate.toISOString();
  // For Sales with pixel: add promoted_object for conversion tracking.
  if (pixelId && (metaObjective === "OUTCOME_SALES" || objective === "SALES")) {
    params.promoted_object = JSON.stringify({
      pixel_id: pixelId,
      custom_event_type: "PURCHASE",
    });
  }

  const data = await marketingFetch(`/act_${adAccountId}/adsets`, accessToken, params);
  return data.id as string;
}

/** Create an ad creative (link ad with image). */
export async function createAdCreative(
  adAccountId: string,
  accessToken: string,
  name: string,
  opts: {
    imageUrl: string;
    headline: string;
    primaryText: string;
    description?: string;
    destinationUrl: string;
    cta?: string;
    pageId: string;
  },
): Promise<string> {
  accessToken = decryptToken(accessToken);
  // Resolve redirects — Meta's adimages API doesn't follow them.
  let imageUrl = opts.imageUrl;
  try {
    const headRes = await fetch(imageUrl, { method: "HEAD", redirect: "follow" });
    if (headRes.url && headRes.url !== imageUrl) {
      imageUrl = headRes.url;
    }
  } catch {
    // If HEAD fails, try with the original URL.
  }

  // Step 1: upload media. Videos go to advideos, images to adimages.
  const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(imageUrl);
  let objectStorySpec: Record<string, unknown>;

  if (isVideo) {
    // Upload video file URL to get video ID.
    const vid = await marketingFetch(`/act_${adAccountId}/advideos`, accessToken, {
      file_url: imageUrl,
    });
    const videoId = vid.id as string | undefined;
    if (!videoId) throw new Error("Meta could not fetch the creative video URL.");
    objectStorySpec = {
      page_id: opts.pageId,
      video_data: {
        video_id: videoId,
        title: opts.headline,
        message: opts.primaryText,
        link_description: opts.description ?? "",
        call_to_action: opts.cta
          ? { type: opts.cta, value: { link: opts.destinationUrl } }
          : undefined,
      },
    };
  } else {
    // Download the image and upload bytes directly (more reliable than URL fetch).
    let imageHash: string | undefined;
    try {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const contentType = imgRes.headers.get("content-type") || "image/jpeg";
      const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";

      const formData = new FormData();
      formData.append("access_token", accessToken);
      formData.append("filename", new Blob([imgBuffer], { type: contentType }), `creative.${ext}`);

      const uploadRes = await fetch(`${GRAPH_BASE}/act_${adAccountId}/adimages`, {
        method: "POST",
        body: formData,
      });
      const uploadData = (await uploadRes.json()) as GraphError & Record<string, any>;
      if (!uploadRes.ok || uploadData.error) {
        throw new Error(uploadData.error?.message || `Upload failed: ${uploadRes.status}`);
      }
      imageHash = Object.values(
        uploadData.images as Record<string, { hash: string }>,
      )[0]?.hash;
    } catch (e) {
      // Fallback to URL method if direct upload fails.
      const img = await marketingFetch(`/act_${adAccountId}/adimages`, accessToken, {
        url: imageUrl,
      });
      imageHash = Object.values(
        img.images as Record<string, { hash: string }>,
      )[0]?.hash;
    }
    if (!imageHash) throw new Error("Meta could not process the creative image.");

    objectStorySpec = {
      page_id: opts.pageId,
      link_data: {
        image_hash: imageHash,
        link: opts.destinationUrl,
        message: opts.primaryText,
        name: opts.headline,
        description: opts.description ?? "",
        call_to_action: opts.cta
          ? { type: opts.cta, value: { link: opts.destinationUrl } }
          : undefined,
      },
    };
  }

  const data = await marketingFetch(`/act_${adAccountId}/adcreatives`, accessToken, {
    name,
    object_story_spec: JSON.stringify(objectStorySpec),
  });
  return data.id as string;
}

/** Create the ad itself linking ad set + creative. */
export async function createAd(
  adAccountId: string,
  accessToken: string,
  name: string,
  adSetId: string,
  creativeId: string,
): Promise<string> {
  const data = await marketingFetch(`/act_${adAccountId}/ads`, accessToken, {
    name,
    adset_id: adSetId,
    creative: JSON.stringify({ creative_id: creativeId }),
    status: "PAUSED",
  });
  return data.id as string;
}

/** Publish a full campaign (campaign + ad set + creative + ad), then activate. */
export interface PublishCreativeInput {
  headline: string;
  primaryText: string;
  description?: string;
  imageUrl: string;
  destinationUrl: string;
  cta?: string;
}

export interface PublishAdSetInput {
  name: string;
  dailyBudget: number;
  startDate?: Date | null;
  endDate?: Date | null;
}

/** Publish a full campaign: 1 campaign + N ad sets + M creatives per ad set, then activate. */
export async function publishFullCampaign(input: {
  adAccountId: string;
  accessToken: string;
  pageId: string;
  name: string;
  objective: string;
  adSets: PublishAdSetInput[];
  creatives: PublishCreativeInput[];
  /** Optional per-ad-set custom targeting (e.g. saved/custom audiences). */
  adSetTargeting?: Record<string, unknown>;
}): Promise<{ campaignId: string; adSetIds: string[]; adIds: string[] }> {
  if (input.adSets.length === 0) throw new Error("At least one ad set is required.");
  if (input.creatives.length === 0) throw new Error("At least one creative is required.");

  const campaignId = await createCampaign(
    input.adAccountId,
    input.accessToken,
    input.name,
    input.objective,
  );

  const adSetIds: string[] = [];
  const adIds: string[] = [];

  for (let i = 0; i < input.adSets.length; i++) {
    const adSet = input.adSets[i];
    const adSetId = await createAdSet(
      input.adAccountId,
      input.accessToken,
      campaignId,
      adSet.name,
      adSet.dailyBudget,
      adSet.startDate,
      adSet.endDate,
      input.adSetTargeting,
      input.objective,
    );
    adSetIds.push(adSetId);

    for (let j = 0; j < input.creatives.length; j++) {
      const creative = input.creatives[j];
      const creativeId = await createAdCreative(
        input.adAccountId,
        input.accessToken,
        `${input.name} - Creative ${j + 1}`,
        { ...creative, pageId: input.pageId },
      );
      const adId = await createAd(
        input.adAccountId,
        input.accessToken,
        `${input.name} - Ad ${i + 1}.${j + 1}`,
        adSetId,
        creativeId,
      );
      adIds.push(adId);
    }
  }

  // Activate everything now that the ads are fully built.
  await marketingFetch(`/${campaignId}`, input.accessToken, { status: "ACTIVE" });
  for (const adSetId of adSetIds) {
    await marketingFetch(`/${adSetId}`, input.accessToken, { status: "ACTIVE" });
  }
  for (const adId of adIds) {
    await marketingFetch(`/${adId}`, input.accessToken, { status: "ACTIVE" });
  }

  return { campaignId, adSetIds, adIds };
}

/** Fetch campaigns with basic insights. */
export async function getCampaigns(adAccountId: string, accessToken: string) {
  const data = await marketingFetch(
    `/act_${adAccountId}/campaigns`,
    accessToken,
    {
      fields: "id,name,objective,status,daily_budget",
      limit: "50",
    },
    "GET",
  );
  return (data.data ?? []) as Array<{
    id: string;
    name: string;
    objective: string;
    status: string;
    daily_budget?: string;
  }>;
}

/** Fetch performance insights for a campaign (last 30 days). */
export async function getCampaignInsights(
  campaignId: string,
  accessToken: string,
): Promise<{
  impressions: number;
  clicks: number;
  spend: number;
  ctr: number;
  cpc: number;
  cpm: number;
  reach?: number;
  actions?: Array<{ action_type: string; value: string }>;
}> {
  const data = await marketingFetch(
    `/${campaignId}/insights`,
    accessToken,
    {
      fields: "impressions,clicks,spend,ctr,cpc,cpm,reach,actions",
      date_preset: "last_30d",
    },
    "GET",
  );
  const row = data.data?.[0] ?? {};
  return {
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    spend: Number(row.spend ?? 0),
    ctr: Number(row.ctr ?? 0),
    cpc: Number(row.cpc ?? 0),
    cpm: Number(row.cpm ?? 0),
    reach: row.reach ? Number(row.reach) : undefined,
    actions: row.actions,
  };
}

/** Pause or resume a campaign. */
export async function toggleCampaign(
  campaignId: string,
  accessToken: string,
  active: boolean,
): Promise<void> {
  await marketingFetch(`/${campaignId}`, accessToken, {
    status: active ? "ACTIVE" : "PAUSED",
  });
}

/** Delete a campaign from Meta (permanent). */
export async function deleteCampaign(
  campaignId: string,
  accessToken: string,
): Promise<void> {
  await marketingFetch(`/${campaignId}`, accessToken, {}, "DELETE");
}

/** Delete a custom/saved audience from Meta (permanent, best-effort). */
export async function deleteAudience(
  audienceId: string,
  accessToken: string,
): Promise<void> {
  await marketingFetch(`/${audienceId}`, accessToken, {}, "DELETE");
}

/* ------------------------------------------------------------------ */
/* Standalone Audience Manager helpers                                 */
/* ------------------------------------------------------------------ */

export interface WebsiteAudienceInput {
  name: string;
  pixelId: string;
  retentionDays?: number; // 30 | 60 | 90 | 180
  urlContains?: string; // e.g. "/products" — empty = all visitors
}

/** Website Visitors custom audience (subtype WEBSITE). */
export async function createWebsiteAudience(
  adAccountId: string,
  accessToken: string,
  input: WebsiteAudienceInput,
): Promise<string> {
  const retentionSeconds = (input.retentionDays ?? 180) * 86400;
  const data = await marketingFetch(
    `/act_${adAccountId}/customaudiences`,
    accessToken,
    {
      name: input.name,
      description: "Website visitors",
      subtype: "WEBSITE",
      rule: JSON.stringify({
        inclusions: {
          operator: "or",
          rules: [
            {
              event_sources: [{ id: input.pixelId, type: "pixel" }],
              retention_seconds: retentionSeconds,
              filter: {
                operator: "or",
                filters: [
                  {
                    field: "url",
                    operator: "i_contains",
                    value: input.urlContains ?? "",
                  },
                ],
              },
            },
          ],
        },
      }),
      prefill: "true",
    },
  );
  return data.id as string;
}

export interface VideoAudienceInput {
  name: string;
  pageId: string;
  /** Watch percentage threshold: 25 | 50 | 75 | 95 */
  watchPercent?: number;
  retentionDays?: number;
}

/** Video Viewers custom audience (subtype VIDEO) for a Page's videos. */
export async function createVideoAudience(
  adAccountId: string,
  accessToken: string,
  input: VideoAudienceInput,
): Promise<string> {
  const retentionSeconds = (input.retentionDays ?? 180) * 86400;
  const data = await marketingFetch(
    `/act_${adAccountId}/customaudiences`,
    accessToken,
    {
      name: input.name,
      description: `Video viewers (${input.watchPercent ?? 50}% watched)`,
      subtype: "VIDEO",
      rule: JSON.stringify({
        inclusions: {
          operator: "or",
          rules: [
            {
              event_sources: [{ id: input.pageId, type: "page" }],
              retention_seconds: retentionSeconds,
              filter: {
                operator: "or",
                filters: [
                  {
                    field: "event",
                    operator: "equal",
                    value: "video_view",
                  },
                ],
              },
            },
          ],
        },
      }),
      prefill: "true",
    },
  );
  return data.id as string;
}

export interface EngagementAudienceInput {
  name: string;
  pageId: string;
  retentionDays?: number;
}

/** Page Engagers custom audience (subtype ENGAGEMENT). */
export async function createEngagementAudience(
  adAccountId: string,
  accessToken: string,
  input: EngagementAudienceInput,
): Promise<string> {
  return createCustomAudience(adAccountId, accessToken, {
    name: input.name,
    description: "People who engaged with the Page",
    subtype: "VIDEO",
    sourceId: input.pageId,
    retentionDays: input.retentionDays ?? 180,
  });
}

export interface InterestAudienceInput {
  name: string;
  country: string;
  ageMin: number;
  ageMax: number;
  interestKeywords: string[]; // resolved to Meta interest IDs via search
}

/** Search Meta's interest taxonomy for keyword matches. */
export async function searchInterests(
  accessToken: string,
  keyword: string,
): Promise<Array<{ id: string; name: string }>> {
  const data = await marketingFetch(
    "/search",
    accessToken,
    { type: "adinterest", q: keyword, limit: "5" },
    "GET",
  );
  return (data.data ?? []) as Array<{ id: string; name: string }>;
}

/**
 * Interest-based saved audience: country + age + interests.
 * Keywords are resolved to Meta interest IDs via the search API.
 */
export async function createInterestAudience(
  adAccountId: string,
  accessToken: string,
  input: InterestAudienceInput,
): Promise<{ id: string; resolvedInterests: Array<{ id: string; name: string }> }> {
  const resolved: Array<{ id: string; name: string }> = [];
  for (const kw of input.interestKeywords.slice(0, 5)) {
    try {
      const hits = await searchInterests(accessToken, kw);
      if (hits.length > 0 && !resolved.some((r) => r.id === hits[0].id)) {
        resolved.push(hits[0]);
      }
    } catch {
      // skip unresolvable keywords
    }
  }
  if (resolved.length === 0) {
    throw new Error(
      "Could not match your keywords to Meta interests. Try different keywords.",
    );
  }
  const id = await createSavedAudience(adAccountId, accessToken, input.name, {
    countries: [input.country],
    ageMin: input.ageMin,
    ageMax: input.ageMax,
  }).then(async (savedId) => {
    // Attach interests by updating the saved audience targeting.
    await marketingFetch(`/${savedId}`, accessToken, {
      targeting: JSON.stringify({
        geo_locations: { countries: [input.country] },
        age_min: input.ageMin,
        age_max: input.ageMax,
        interests: resolved.map((r) => ({ id: r.id, name: r.name })),
      }),
    });
    return savedId;
  });
  return { id, resolvedInterests: resolved };
}

export interface LookalikeAudienceInput {
  name: string;
  sourceAudienceId: string; // Meta custom-audience ID
  country: string;
  /** 0.01 = 1% similarity */
  ratio?: number;
}

/** Lookalike audience based on an existing custom audience. */
export async function createLookalikeAudience(
  adAccountId: string,
  accessToken: string,
  input: LookalikeAudienceInput,
): Promise<string> {
  const data = await marketingFetch(
    `/act_${adAccountId}/customaudiences`,
    accessToken,
    {
      name: input.name,
      description: "Lookalike audience",
      subtype: "LOOKALIKE",
      origin_audience_id: input.sourceAudienceId,
      lookalike_spec: JSON.stringify({
        country: input.country,
        ratio: input.ratio ?? 0.01,
        type: "similarity",
      }),
    },
  );
  return data.id as string;
}

/** List custom audiences on the ad account (for status/size display). */
export async function listCustomAudiences(adAccountId: string, accessToken: string) {
  const data = await marketingFetch(
    `/act_${adAccountId}/customaudiences`,
    accessToken,
    { fields: "id,name,subtype,approximate_count,description", limit: "100" },
    "GET",
  );
  return (data.data ?? []) as Array<{
    id: string;
    name: string;
    subtype: string;
    approximate_count?: number;
    description?: string;
  }>;
}

export interface SavedAudienceTargeting {
  countries: string[];
  ageMin: number;
  ageMax: number;
}

/**
 * Create a SAVED audience (broad targeting spec) under an ad account.
 * Used for the TOF stage: country + age, no narrow interests (Advantage+ style broad).
 * Returns the saved-audience ID.
 */
export async function createSavedAudience(
  adAccountId: string,
  accessToken: string,
  name: string,
  targeting: SavedAudienceTargeting,
): Promise<string> {
  const data = await marketingFetch(`/act_${adAccountId}/saved_audiences`, accessToken, {
    name,
    targeting: JSON.stringify({
      geo_locations: { countries: targeting.countries },
      age_min: targeting.ageMin,
      age_max: targeting.ageMax,
    }),
  });
  return data.id as string;
}

export interface CustomAudienceInput {
  name: string;
  description?: string;
  /** VIDEO = video viewers/page engagers, WEBSITE = website visitors */
  subtype: "VIDEO" | "WEBSITE";
  /** Page ID (for VIDEO) or pixel ID (for WEBSITE) */
  sourceId: string;
  /** Retention in days (default 180) */
  retentionDays?: number;
}

/**
 * Create a CUSTOM audience under an ad account.
 * - VIDEO: people who engaged with the given Page's videos/content.
 * - WEBSITE: people who visited the website tracked by the given pixel.
 * Returns the custom-audience ID.
 */
export async function createCustomAudience(
  adAccountId: string,
  accessToken: string,
  input: CustomAudienceInput,
): Promise<string> {
  const retentionSeconds = (input.retentionDays ?? 180) * 86400;

  const rule =
    input.subtype === "VIDEO"
      ? {
          inclusions: {
            operator: "or",
            rules: [
              {
                event_sources: [{ id: input.sourceId, type: "page" }],
                retention_seconds: retentionSeconds,
                filter: {
                  operator: "or",
                  filters: [
                    { field: "event", operator: "equal", value: "page_engaged" },
                  ],
                },
              },
            ],
          },
        }
      : {
          inclusions: {
            operator: "or",
            rules: [
              {
                event_sources: [{ id: input.sourceId, type: "pixel" }],
                retention_seconds: retentionSeconds,
                filter: {
                  operator: "or",
                  filters: [
                    { field: "url", operator: "i_contains", value: "" },
                  ],
                },
              },
            ],
          },
        };

  const data = await marketingFetch(
    `/act_${adAccountId}/customaudiences`,
    accessToken,
    {
      name: input.name,
      description: input.description ?? "",
      subtype: input.subtype,
      rule: JSON.stringify(rule),
      prefill: "true",
    },
  );
  return data.id as string;
}

/** List ad pixels owned by the ad account (needed for the website audience). */
export async function getAdPixels(adAccountId: string, accessToken: string) {
  const data = await marketingFetch(
    `/act_${adAccountId}/adspixels`,
    accessToken,
    { fields: "id,name" },
    "GET",
  );
  return (data.data ?? []) as Array<{ id: string; name: string }>;
}

/** Ad set creation with fully custom targeting (for funnel stages). */
export async function createAdSetWithTargeting(
  adAccountId: string,
  accessToken: string,
  campaignId: string,
  opts: {
    name: string;
    dailyBudget: number;
    targeting: Record<string, unknown>;
    optimizationGoal?: string;
    startDate?: Date | null;
    endDate?: Date | null;
  },
): Promise<string> {
  const params: Record<string, string> = {
    name: opts.name,
    campaign_id: campaignId,
    daily_budget: String(Math.round(opts.dailyBudget * 100)), // cents
    billing_event: "IMPRESSIONS",
    optimization_goal: opts.optimizationGoal ?? "REACH",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: JSON.stringify(opts.targeting),
    status: "PAUSED",
  };
  if (opts.startDate) params.start_time = opts.startDate.toISOString();
  if (opts.endDate) params.end_time = opts.endDate.toISOString();

  const data = await marketingFetch(`/act_${adAccountId}/adsets`, accessToken, params);
  return data.id as string;
}

export interface FunnelStageResult {
  stage: "TOF" | "MOF" | "BOF";
  audienceId: string | null;
  audienceFallback: boolean;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  error: string | null;
}

export interface CreateFullFunnelInput {
  adAccountId: string;
  accessToken: string;
  pageId: string;
  funnelName: string;
  totalDailyBudget: number;
  country: string;
  ageMin: number;
  ageMax: number;
  headline: string;
  primaryText: string;
  description?: string;
  imageUrl: string;
  destinationUrl: string;
  cta?: string;
  /** Retry mode: only build these stages (skips the rest entirely). */
  onlyStages?: Array<"TOF" | "MOF" | "BOF">;
}

/**
 * Create a full 3-stage funnel:
 *   1. Create 3 audiences (saved broad for TOF, video-engagement custom for MOF,
 *      website custom for BOF). Audience failures fall back to standard targeting.
 *   2. Create 3 campaigns (AWARENESS / ENGAGEMENT / SALES) with budget split 50/30/20.
 *   3. Create 1 ad set + 1 ad per campaign, then activate everything that succeeded.
 *
 * Returns per-stage results so partial failures can be reported.
 */
export async function createFullFunnel(
  input: CreateFullFunnelInput,
): Promise<{ stages: FunnelStageResult[] }> {
  const { adAccountId, accessToken } = input;
  const geo = { countries: [input.country] };
  const ages = { age_min: input.ageMin, age_max: input.ageMax };

  const stages: FunnelStageResult[] = (["TOF", "MOF", "BOF"] as const).map(
    (stage) => ({
      stage,
      audienceId: null,
      audienceFallback: false,
      campaignId: null,
      adSetId: null,
      adId: null,
      error: null,
    }),
  );
  const byStage = (s: "TOF" | "MOF" | "BOF") => stages.find((x) => x.stage === s)!;
  // Retry mode: only build the requested stages.
  const want = (s: "TOF" | "MOF" | "BOF") =>
    !input.onlyStages || input.onlyStages.includes(s);

  /* ---- Step 1: audiences (each stage gets its own separately created audience) ---- */

  // TOF: saved audience, broad (country + age).
  if (want("TOF")) {
  try {
    byStage("TOF").audienceId = await createSavedAudience(
      adAccountId,
      accessToken,
      `${input.funnelName} - TOF Broad`,
      { countries: [input.country], ageMin: input.ageMin, ageMax: input.ageMax },
    );
  } catch (e) {
    byStage("TOF").audienceFallback = true;
  }
  }

  // MOF: custom audience — video viewers + page engagers.
  if (want("MOF")) {
  try {
    byStage("MOF").audienceId = await createCustomAudience(adAccountId, accessToken, {
      name: `${input.funnelName} - MOF Video Viewers`,
      description: "People who watched videos / engaged with the Page",
      subtype: "VIDEO",
      sourceId: input.pageId,
    });
  } catch (e) {
    byStage("MOF").audienceFallback = true;
  }
  }

  // BOF: custom audience — website visitors (needs a pixel on the ad account).
  if (want("BOF")) {
  try {
    const pixels = await getAdPixels(adAccountId, accessToken);
    if (pixels.length === 0) {
      throw new Error(
        "No Meta pixel found on this ad account. Install a pixel to use website retargeting.",
      );
    }
    byStage("BOF").audienceId = await createCustomAudience(adAccountId, accessToken, {
      name: `${input.funnelName} - BOF Website Visitors`,
      description: "People who visited the website",
      subtype: "WEBSITE",
      sourceId: pixels[0].id,
    });
  } catch (e) {
    byStage("BOF").audienceFallback = true;
  }
  }

  /* ---- Step 2: campaigns + ad sets + ads per stage ---- */

  const stageDefs = [
    {
      stage: "TOF" as const,
      objective: "AWARENESS",
      budgetShare: 0.5,
      optimizationGoal: "REACH",
      targeting: () =>
        byStage("TOF").audienceId && !byStage("TOF").audienceFallback
          ? {
              saved_audience_id: byStage("TOF").audienceId,
              ...geo,
              ...ages,
            }
          : { geo_locations: geo, ...ages },
    },
    {
      stage: "MOF" as const,
      objective: "ENGAGEMENT",
      budgetShare: 0.3,
      optimizationGoal: "ENGAGED_USERS",
      targeting: () =>
        byStage("MOF").audienceId && !byStage("MOF").audienceFallback
          ? {
              custom_audiences: [{ id: byStage("MOF").audienceId }],
              ...geo,
              ...ages,
            }
          : { geo_locations: geo, ...ages },
    },
    {
      stage: "BOF" as const,
      objective: "SALES",
      budgetShare: 0.2,
      optimizationGoal: "LINK_CLICKS",
      targeting: () =>
        byStage("BOF").audienceId && !byStage("BOF").audienceFallback
          ? {
              custom_audiences: [{ id: byStage("BOF").audienceId }],
              ...geo,
              ...ages,
            }
          : { geo_locations: geo, ...ages },
    },
  ];

  for (const def of stageDefs.filter((d) => want(d.stage))) {
    const res = byStage(def.stage);
    try {
      const campaignName = `${input.funnelName} - ${def.stage}`;
      const campaignId = await createCampaign(
        adAccountId,
        accessToken,
        campaignName,
        def.objective,
      );
      res.campaignId = campaignId;

      const dailyBudget = Math.max(
        1,
        Math.round(input.totalDailyBudget * def.budgetShare * 100) / 100,
      );
      const adSetId = await createAdSetWithTargeting(
        adAccountId,
        accessToken,
        campaignId,
        {
          name: `${campaignName} - Ad Set`,
          dailyBudget,
          targeting: def.targeting(),
          optimizationGoal: def.optimizationGoal,
        },
      );
      res.adSetId = adSetId;

      const creativeId = await createAdCreative(
        adAccountId,
        accessToken,
        `${campaignName} - Creative`,
        {
          imageUrl: input.imageUrl,
          headline: input.headline,
          primaryText: input.primaryText,
          description: input.description,
          destinationUrl: input.destinationUrl,
          cta: input.cta,
          pageId: input.pageId,
        },
      );
      const adId = await createAd(
        adAccountId,
        accessToken,
        `${campaignName} - Ad`,
        adSetId,
        creativeId,
      );
      res.adId = adId;

      // Activate this stage's assets.
      await marketingFetch(`/${campaignId}`, accessToken, { status: "ACTIVE" });
      await marketingFetch(`/${adSetId}`, accessToken, { status: "ACTIVE" });
      await marketingFetch(`/${adId}`, accessToken, { status: "ACTIVE" });
    } catch (e) {
      res.error = e instanceof Error ? e.message : "Stage publish failed.";
    }
  }

  return { stages };
}
