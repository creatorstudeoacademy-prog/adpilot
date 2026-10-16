/**
 * AI sector constants — client-safe (no server imports).
 * Import this (not agents.server.ts) from components.
 * Part of the portable AI module.
 */

/** Sectors an agent can be assigned to. Extend this list to add new skills. */
export const SECTORS = ["caption", "hashtag", "ad_copy", "audience"] as const;
export type Sector = (typeof SECTORS)[number];
