import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/**
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

export async function getSettings(
  admin: AdminApiContext,
): Promise<PixelSettings> {
  const response = await admin.graphql(
    `#graphql
      query GetPixelConfig($namespace: String!, $key: String!) {
        shop {
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }`,
    {
      variables: {
        namespace: SETTINGS_NAMESPACE,
        key: SETTINGS_KEY,
      },
    },
  );

  const data = await response.json();
  const raw = data?.data?.shop?.metafield?.value as string | undefined;
  if (!raw) return { ...DEFAULT_SETTINGS };

  try {
    const parsed = JSON.parse(raw) as Partial<PixelSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    // Corrupt JSON — fall back to defaults rather than crashing the admin UI.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(
  admin: AdminApiContext,
  settings: PixelSettings,
): Promise<void> {
  // metafieldsSet needs the shop GID as owner.
  const shopResponse = await admin.graphql(
    `#graphql
      query GetShopId {
        shop {
          id
        }
      }`,
  );
  const shopData = await shopResponse.json();
  const shopId = shopData?.data?.shop?.id as string | undefined;
  if (!shopId) {
    throw new Error("Could not resolve shop ID; settings were not saved.");
  }

  const response = await admin.graphql(
    `#graphql
      mutation SetPixelConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: SETTINGS_NAMESPACE,
            key: SETTINGS_KEY,
            type: "json",
            value: JSON.stringify(settings),
          },
        ],
      },
    },
  );

  const data = await response.json();
  const userErrors = data?.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      userErrors.map((e: { message: string }) => e.message).join("; "),
    );
  }
}
