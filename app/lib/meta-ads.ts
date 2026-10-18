/** Client-safe constants for Meta ads. No server-only imports here. */

/** Objective mapping: our names -> Meta objectives. */
export const OBJECTIVE_MAP: Record<string, string> = {
  AWARENESS: "OUTCOME_AWARENESS",
  TRAFFIC: "OUTCOME_TRAFFIC",
  ENGAGEMENT: "OUTCOME_ENGAGEMENT",
  SALES: "OUTCOME_SALES",
  CATALOG_SALES: "OUTCOME_SALES",
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
  {
    id: "CATALOG_SALES",
    name: "Catalog Sales",
    description: "Dynamic ads from your product catalog — Meta shows the right product to each person.",
  },
];
