/**
 * Shared pricing constants (safe to import from client components).
 */

/** Flat fee per social post published (USD). Deducted from wallet on publish. */
export const POST_PUBLISH_FEE = 0.5;

/** Fee per AI caption generation (USD). Deducted from wallet per generation. */
export const AI_GENERATION_FEE = 0.2;

/** Per-ad publish fees by campaign objective (USD). Deducted from wallet on publish. */
export const OBJECTIVE_FEES: Record<string, number> = {
  AWARENESS: 2,
  TRAFFIC: 2.5,
  ENGAGEMENT: 2.5,
  SALES: 3,
};

export const OBJECTIVE_FEE_LABELS: Record<string, string> = {
  AWARENESS: "Awareness",
  TRAFFIC: "Traffic",
  ENGAGEMENT: "Engagement",
  SALES: "Sales",
};

/** Extra fee per ad set beyond the first (USD). */
export const EXTRA_ADSET_FEE = 1.5;

/** Extra fee per creative beyond the first (USD). */
export const EXTRA_CREATIVE_FEE = 1;

/** Fee per custom/saved audience created for a funnel (USD). */
export const AUDIENCE_FEE = 1;

/** Fee for a standalone audience from Audience Manager (USD). */
export const STANDALONE_AUDIENCE_FEE = 1;

/** Fee for a lookalike audience (USD). */
export const LOOKALIKE_AUDIENCE_FEE = 1.5;

/** Full-funnel fee breakdown: 3 campaigns + 3 audiences = $10.50 */
export const FUNNEL_CAMPAIGN_FEE =
  OBJECTIVE_FEES.AWARENESS + OBJECTIVE_FEES.ENGAGEMENT + OBJECTIVE_FEES.SALES; // 2 + 2.5 + 3 = 7.5
export const FUNNEL_AUDIENCE_COUNT = 3;
export const FUNNEL_AUDIENCE_FEE = AUDIENCE_FEE * FUNNEL_AUDIENCE_COUNT; // 3
export const FUNNEL_TOTAL_FEE = FUNNEL_CAMPAIGN_FEE + FUNNEL_AUDIENCE_FEE; // 10.5

/** Budget split for the full funnel (fraction of total daily budget). */
export const FUNNEL_BUDGET_SPLIT = {
  TOF: 0.5,
  MOF: 0.3,
  BOF: 0.2,
} as const;

export interface FeeBreakdown {
  base: number;
  objectiveLabel: string;
  extraAdSets: number;
  extraAdSetCount: number;
  extraCreatives: number;
  extraCreativeCount: number;
  total: number;
}

/**
 * Calculate the total publish fee:
 * base (by objective) + $1.50 per extra ad set + $1 per extra creative.
 * Example: Sales + 2 ad sets + 3 creatives = 3 + 1.5 + 2 = $6.50
 */
export function calculatePublishFee(
  objective: string,
  adSetCount: number,
  creativeCount: number,
): FeeBreakdown {
  const base = OBJECTIVE_FEES[objective] ?? OBJECTIVE_FEES.TRAFFIC;
  const extraAdSetCount = Math.max(0, Math.floor(adSetCount) - 1);
  const extraCreativeCount = Math.max(0, Math.floor(creativeCount) - 1);
  const extraAdSets = extraAdSetCount * EXTRA_ADSET_FEE;
  const extraCreatives = extraCreativeCount * EXTRA_CREATIVE_FEE;
  return {
    base,
    objectiveLabel: OBJECTIVE_FEE_LABELS[objective] ?? objective,
    extraAdSets,
    extraAdSetCount,
    extraCreatives,
    extraCreativeCount,
    total: base + extraAdSets + extraCreatives,
  };
}

/** Wallet topup packs: price charged -> credit added (bonus included). */
export const TOPUP_PACKS = [
  { price: 5, credit: 5, label: "$5", sublabel: "$5 value" },
  { price: 10, credit: 10, label: "$10", sublabel: "$10 value" },
  { price: 30, credit: 30, label: "$30", sublabel: "$30 value" },
  { price: 90, credit: 100, label: "$90", sublabel: "$90 + $10 bonus = $100 value" },
  { price: 240, credit: 300, label: "$240", sublabel: "$240 + $60 bonus = $300 value" },
];
