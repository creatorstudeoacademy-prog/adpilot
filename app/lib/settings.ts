/**
 * Shared pixel-settings data (types, constants, defaults).
 * Client-safe: no server imports here.
 *
 * Pixel configuration is stored as JSON in a shop metafield so the theme app
 * extension can read it directly in Liquid (no app proxy required).
 *
 * Namespace: pixelpro
 * Key:       config
 * Type:      json
 */
export const SETTINGS_NAMESPACE = "pixelpro";
export const SETTINGS_KEY = "config";

export interface PixelSettings {
  enabled: boolean;
  /** Meta (Facebook) Pixel ID, e.g. "1683359659412165" */
  metaPixelId: string;
  /** TikTok Pixel ID, e.g. "D2ABCD1234EFGH5678" */
  tiktokPixelId: string;
  /** Google Tag ID — GA4 (G-XXXXXXXXXX) or Google Ads (AW-XXXXXXXXXX) */
  googleTagId: string;
  /** Snapchat Pixel ID, e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
  snapchatPixelId: string;
}

export const DEFAULT_SETTINGS: PixelSettings = {
  enabled: true,
  metaPixelId: "",
  tiktokPixelId: "",
  googleTagId: "",
  snapchatPixelId: "",
};

/** Fields only available on the PixelPro plan. Free shops get DEFAULT_SETTINGS values. */
export const PRO_ONLY_FIELDS: (keyof PixelSettings)[] = [
  "tiktokPixelId",
  "googleTagId",
  "snapchatPixelId",
];
