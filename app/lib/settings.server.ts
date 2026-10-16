import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SETTINGS_NAMESPACE,
  type PixelSettings,
} from "./settings";

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
