/**
 * AI sector constants — client-safe (no server imports).
 * Import this (not agents.server.ts) from components.
 * Part of the portable AI module.
 */

/** Sectors an agent can be assigned to. Extend this list to add new skills. */
export const SECTORS = [
  "caption",
  "hashtag",
  "ad_copy",
  "audience",
  "campaign",
] as const;
export type Sector = (typeof SECTORS)[number];

/** Human-readable English labels for the admin panel. */
export const SECTOR_LABELS: Record<Sector, string> = {
  caption: "Caption",
  hashtag: "Hashtag",
  ad_copy: "Ad copy",
  audience: "Audience",
  campaign: "Campaign",
};
