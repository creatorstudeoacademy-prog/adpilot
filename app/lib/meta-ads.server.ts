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
  method: "GET" | "POST" = "POST",
): Promise<any> {
  const url =
    method === "GET"
      ? `${GRAPH_BASE}${path}?${new URLSearchParams({ access_token: accessToken, ...params })}`
      : `${GRAPH_BASE}${path}`;
  const body =
    method === "POST"
      ? new URLSearchParams({ access_token: accessToken, ...params })
      : undefined;

  const res = await fetch(url, { method, body });
  const data = (await res.json()) as GraphError & Record<string, any>;
  if (!res.ok || data.error) {
    throw new Error(
      friendlyMetaError(data.error?.message ?? `Meta API error (HTTP ${res.status})`),
    );
  }
  return data;
}

/** Turn raw Meta errors into user-friendly messages. */
function friendlyMetaError(message: string): string {
  if (/permission|authorized|scope/i.test(message))
    return "Meta denied this action. Your Meta app may need App Review approval for ads permissions (ads_management, ads_read).";
  if (/budget/i.test(message))
    return `Budget issue: ${message}`;
  if (/account.*(disabled|inactive|restricted)/i.test(message))
    return "This ad account is disabled or restricted in Meta Ads Manager.";
  return message;
}

/** Objective mapping: our names -> Meta objectives. */
export const OBJECTIVE_MAP: Record<string, string> = {
  AWARENESS: "OUTCOME_AWARENESS",
  TRAFFIC: "OUTCOME_TRAFFIC",
  ENGAGEMENT: "OUTCOME_ENGAGEMENT",
  SALES: "OUTCOME_SALES",
};

export const OBJECTIVES = [
  {
    id: "AWARENESS",
    name: "Brand Awareness",
    description: "Show your ads to people most likely to remember them.",
  },
  {
    id: "TRAFFIC",
    name: "Traffic",
    description: "Send people to your website or landing page.",
  },
  {
    id: "ENGAGEMENT",
    name: "Engagement",
    description: "Get more likes, comments, shares and Page follows.",
  },
  {
    id: "SALES",
    name: "Sales",
    description: "Find people likely to purchase your products.",
  },
];

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
  const metaObjective = OBJECTIVE_MAP[objective] ?? OBJECTIVE_MAP.TRAFFIC;
  const data = await marketingFetch(`/act_${adAccountId}/campaigns`, accessToken, {
    name,
    objective: metaObjective,
    status: "PAUSED", // start paused; activate after ad is ready
    special_ad_categories: "[]",
  });
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
): Promise<string> {
  const params: Record<string, string> = {
    name,
    campaign_id: campaignId,
    daily_budget: String(Math.round(dailyBudget * 100)), // Meta expects cents
    billing_event: "IMPRESSIONS",
    optimization_goal: "REACH",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: JSON.stringify({
      geo_locations: { countries: ["US"] },
      age_min: 18,
      age_max: 65,
    }),
    status: "PAUSED",
  };
  if (startDate) params.start_time = startDate.toISOString();
  if (endDate) params.end_time = endDate.toISOString();

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
  // Step 1: upload image to get image_hash.
  const img = await marketingFetch(`/act_${adAccountId}/adimages`, accessToken, {
    url: opts.imageUrl,
  });
  const imageHash = Object.values(
    img.images as Record<string, { hash: string }>,
  )[0]?.hash;
  if (!imageHash) throw new Error("Meta could not fetch the creative image URL.");

  const objectStorySpec = {
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
