/**
 * Shared pricing constants (safe to import from client components).
 */

/** Flat fee per social post published (USD). Deducted from wallet on publish. */
export const POST_PUBLISH_FEE = 0.2;

/** Fee per AI caption generation (USD). Deducted from wallet per generation. */
export const AI_GENERATION_FEE = 0.2;

/** Fee per AI image generation (USD). Deducted from wallet per generation. */
export const AI_IMAGE_GENERATION_FEE = 0.4;

/** Per-ad publish fees by campaign objective (USD). Deducted from wallet on publish. */
export const OBJECTIVE_FEES: Record<string, number> = {
  AWARENESS: 2,
  TRAFFIC: 2.5,
  ENGAGEMENT: 2.5,
  SALES: 3,
  CATALOG_SALES: 3,
};

export const OBJECTIVE_FEE_LABELS: Record<string, string> = {
  AWARENESS: "Awareness",
  TRAFFIC: "Traffic",
  ENGAGEMENT: "Engagement",
  SALES: "Sales",
  CATALOG_SALES: "Catalog Sales",
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

/** Fee for AI auto-created audience (USD). Includes AI targeting generation. */
export const AI_AUDIENCE_FEE = 1.2;

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

/* ── Scheduled post fees by content type (USD, per post, manual upload) ── */
/** Text-only post. */
export const TEXT_POST_FEE = 0.2;
/** Text + photo post. */
export const PHOTO_POST_FEE = 0.35;
/** Text + video post. */
export const VIDEO_POST_FEE = 0.5;

/* ── Auto-schedule packages (USD, one-time; includes N scheduled text posts) ── */
export interface SchedulePackageDef {
  id: string;
  days: number;
  posts: number;
  fee: number;
  label: string;
  sublabel: string;
}
export const SCHEDULE_PACKAGES: SchedulePackageDef[] = [
  { id: "7d", days: 7, posts: 7, fee: 1.2, label: "7-Day Auto-Post", sublabel: "7 scheduled text posts · $1.20" },
  { id: "15d", days: 15, posts: 15, fee: 2.5, label: "15-Day Auto-Post", sublabel: "15 scheduled text posts · $2.50" },
  { id: "30d", days: 30, posts: 30, fee: 4.5, label: "30-Day Auto-Post", sublabel: "30 scheduled text posts · $4.50" },
];

/** FUTURE: auto-post with photo / video (not yet available). */
export const AUTO_MEDIA_COMING_SOON = true;

/* ── Lifetime Auto-Post (3-month billing cycles, up to 10 posts/day) ── */
export const LIFETIME_MAX_POSTS_PER_DAY = 10;
export const LIFETIME_BILLING_DAYS = 90;
export const LIFETIME_DISCOUNT = 0.25; // 25% off for 3-month commitment
/** 3-month upfront fee for N posts/day. */
export function lifetimeFee(postsPerDay: number): number {
  const n = Math.max(1, Math.min(LIFETIME_MAX_POSTS_PER_DAY, Math.floor(postsPerDay)));
  return Math.round(n * LIFETIME_BILLING_DAYS * TEXT_POST_FEE * (1 - LIFETIME_DISCOUNT) * 100) / 100;
}

/** Lifetime pack tiers (posts/day). */
export interface LifetimePackDef {
  id: string;
  postsPerDay: number;
  label: string;
}
export const LIFETIME_PACKS: LifetimePackDef[] = [
  { id: "lt-starter", postsPerDay: 3, label: "Starter" },
  { id: "lt-growth", postsPerDay: 5, label: "Growth" },
  { id: "lt-pro", postsPerDay: 10, label: "Pro" },
];
