import { useCallback, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";

import { PRO_PLAN, authenticate } from "../shopify.server";
import {
  DEFAULT_SETTINGS,
  PRO_ONLY_FIELDS,
  type PixelSettings,
} from "../lib/settings";
import { getSettings, saveSettings } from "../lib/settings.server";

const IS_TEST_BILLING = process.env.NODE_ENV !== "production";

interface SettingsActionData {
  ok: boolean;
  errors: Record<string, string>;
}

function validatePixelId(
  key: keyof PixelSettings,
  value: string,
): string | null {
  const v = value.trim();
  if (!v) return null; // optional — empty means "don't install this pixel"
  if (/\s/.test(v)) return "Pixel IDs cannot contain spaces.";
  if (v.length > 64) return "Pixel ID looks too long — check for a copy/paste error.";
  switch (key) {
    case "metaPixelId":
      return /^\d{6,20}$/.test(v)
        ? null
        : "Meta Pixel ID should be digits only, e.g. 1683359659412165.";
    case "tiktokPixelId":
      return /^[A-Za-z0-9]{10,32}$/.test(v)
        ? null
        : "TikTok Pixel ID should be letters and numbers, e.g. D2ABCD1234EFGH5678.";
    case "googleTagId":
      return /^(G|AW)-[A-Za-z0-9-]{5,20}$/.test(v)
        ? null
        : "Google Tag ID should look like G-XXXXXXXXXX or AW-XXXXXXXXXX.";
    case "snapchatPixelId":
      return /^[A-Za-z0-9-]{8,64}$/.test(v)
        ? null
        : "Snapchat Pixel ID looks invalid — copy it exactly from Snapchat Ads Manager.";
    default:
      return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);

  const [settings, billingCheck, embedStatus] = await Promise.all([
    getSettings(admin),
    billing.check({ plans: [PRO_PLAN], isTest: IS_TEST_BILLING }),
    checkEmbedEnabled(admin),
  ]);

  return json({
    settings,
    isPro: billingCheck.hasActivePayment,
    embedEnabled: embedStatus.enabled,
    shopDomain: session.shop,
  });
};

/**
 * Checks whether the PixelPro app embed block is enabled on the published theme.
 * Reads the main theme's settings_data.json via the Asset API (needs read_themes).
 */
async function checkEmbedEnabled(
  admin: any,
): Promise<{ enabled: boolean }> {
  try {
    const response = await admin.graphql(
      `#graphql
        query GetMainTheme {
          themes(first: 10) {
            nodes {
              id
              role
            }
          }
        }`,
    );
    const data = await response.json();
    const themes = data?.data?.themes?.nodes ?? [];
    const mainTheme = themes.find((t: any) => t.role === "MAIN") ?? themes[0];
    if (!mainTheme) return { enabled: false };

    const themeId = String(mainTheme.id).split("/").pop();

    const assetResponse = await admin.graphql(
      `#graphql
        query GetSettingsData($themeId: ID!) {
          theme(id: $themeId) {
            files(filenames: ["config/settings_data.json"], first: 1) {
              nodes {
                ... on OnlineStoreThemeFile {
                  content
                }
              }
            }
          }
        }`,
      { variables: { themeId: mainTheme.id } },
    );
    void themeId;
    const assetData = await assetResponse.json();
    const content =
      assetData?.data?.theme?.files?.nodes?.[0]?.content ?? "";
    if (!content) return { enabled: false };

    const settingsData = JSON.parse(content);
    const blocks = settingsData?.current?.blocks ?? {};
    // App embed blocks are keyed like "<api_key>/pixel-pro" or contain "pixel-pro"
    for (const [key, block] of Object.entries(blocks) as [string, any][]) {
      if (key.includes("pixel-pro") || block?.type === "pixel-pro") {
        return { enabled: block?.disabled !== true };
      }
    }
    return { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, billing } = await authenticate.admin(request);
  const formData = await request.formData();

  const billingCheck = await billing.check({
    plans: [PRO_PLAN],
    isTest: IS_TEST_BILLING,
  });
  const isPro = billingCheck.hasActivePayment;

  const errors: Record<string, string> = {};

  const values: Record<keyof PixelSettings, string> = {
    enabled: "",
    metaPixelId: String(formData.get("metaPixelId") ?? "").trim(),
    tiktokPixelId: String(formData.get("tiktokPixelId") ?? "").trim(),
    googleTagId: String(formData.get("googleTagId") ?? "").trim(),
    snapchatPixelId: String(formData.get("snapchatPixelId") ?? "").trim(),
  };

  for (const key of ["metaPixelId", "tiktokPixelId", "googleTagId", "snapchatPixelId"] as const) {
    const err = validatePixelId(key, values[key]);
    if (err) errors[key] = err;
  }

  if (
    !values.metaPixelId &&
    !values.tiktokPixelId &&
    !values.googleTagId &&
    !values.snapchatPixelId
  ) {
    errors.form = "Add at least one pixel ID so PixelPro has something to install.";
  }

  if (Object.keys(errors).length > 0) {
    const data: SettingsActionData = { ok: false, errors };
    return json(data, { status: 400 });
  }

  const settings: PixelSettings = {
    enabled: formData.get("enabled") === "on",
    metaPixelId: values.metaPixelId,
    // Pro-only pixels: free shops always get the defaults (server-enforced).
    tiktokPixelId: isPro ? values.tiktokPixelId : DEFAULT_SETTINGS.tiktokPixelId,
    googleTagId: isPro ? values.googleTagId : DEFAULT_SETTINGS.googleTagId,
    snapchatPixelId: isPro
      ? values.snapchatPixelId
      : DEFAULT_SETTINGS.snapchatPixelId,
  };

  try {
    await saveSettings(admin, settings);
  } catch (e) {
    const data: SettingsActionData = {
      ok: false,
      errors: {
        form: e instanceof Error ? e.message : "Could not save settings.",
      },
    };
    return json(data, { status: 500 });
  }

  const success: SettingsActionData = { ok: true, errors: {} };
  return json(success);
};

/** Status summary of which pixels will be injected on the storefront. */
function PixelStatus({ settings }: { settings: PixelSettings }) {
  const pixels = [
    { label: "Meta", id: settings.metaPixelId },
    { label: "TikTok", id: settings.tiktokPixelId },
    { label: "Google", id: settings.googleTagId },
    { label: "Snapchat", id: settings.snapchatPixelId },
  ];
  const active = pixels.filter((p) => p.id.trim().length > 0);

  return (
    <BlockStack gap="200">
      {pixels.map((p) => (
        <InlineStack key={p.label} align="space-between" blockAlign="center">
          <Text as="span" variant="bodyMd">
            {p.label} Pixel
          </Text>
          {p.id.trim() ? (
            <Badge tone="success">Installed</Badge>
          ) : (
            <Badge>Not set</Badge>
          )}
        </InlineStack>
      ))}
      <Divider />
      <Text as="p" variant="bodySm" tone="subdued">
        {settings.enabled
          ? active.length > 0
            ? `${active.length} pixel${active.length > 1 ? "s" : ""} will fire PageView, ViewContent, AddToCart, InitiateCheckout and Purchase events on your storefront.`
            : "Tracking is enabled but no pixel IDs are set yet."
          : "Tracking is paused — no pixels will fire until you re-enable it."}
      </Text>
    </BlockStack>
  );
}

export default function SettingsPage() {
  const {
    settings: initial,
    isPro,
    embedEnabled,
    shopDomain,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<SettingsActionData>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSaving = navigation.state === "submitting";

  const [form, setForm] = useState<PixelSettings>(initial);

  const set = useCallback(
    <K extends keyof PixelSettings>(key: K, value: PixelSettings[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const proLocked = useMemo(
    () => (field: keyof PixelSettings) =>
      !isPro && (PRO_ONLY_FIELDS as string[]).includes(field),
    [isPro],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData();
      data.set("enabled", form.enabled ? "on" : "");
      data.set("metaPixelId", form.metaPixelId);
      data.set("tiktokPixelId", form.tiktokPixelId);
      data.set("googleTagId", form.googleTagId);
      data.set("snapchatPixelId", form.snapchatPixelId);
      submit(data, { method: "post" });
    },
    [form, submit],
  );

  const errors = actionData?.errors ?? {};

  return (
    <Page
      title="PixelPro — Multi Pixel Manager"
      subtitle={isPro ? "PixelPro plan active" : "Free plan"}
      primaryAction={{
        content: isSaving ? "Saving…" : "Save settings",
        disabled: isSaving,
        onAction: () => {
          const el = document.getElementById("pixelpro-settings-form");
          if (el instanceof HTMLFormElement) el.requestSubmit();
        },
      }}
    >
      <BlockStack gap="500">
        {actionData?.ok && (
          <Banner tone="success" onDismiss={() => {}}>
            Settings saved. Your pixels update on the storefront immediately.
          </Banner>
        )}
        {errors.form && <Banner tone="critical">{errors.form}</Banner>}
        {!isPro && (
          <Banner
            title="Unlock all 4 pixels with PixelPro"
            tone="info"
            action={{ content: "View plans", url: "/app/billing" }}
          >
            The Free plan installs the Meta Pixel only. PixelPro adds TikTok,
            Google and Snapchat pixels — $12.99/month with a 7-day free trial.
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <form id="pixelpro-settings-form" onSubmit={handleSubmit}>
              <BlockStack gap="500">
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Tracking status
                    </Text>
                    <FormLayout>
                      <Checkbox
                        label="Enable pixel tracking on the storefront"
                        checked={form.enabled}
                        onChange={(v) => set("enabled", v)}
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Meta (Facebook) Pixel
                    </Text>
                    <FormLayout>
                      <TextField
                        label="Meta Pixel ID"
                        value={form.metaPixelId}
                        onChange={(v) => set("metaPixelId", v)}
                        placeholder="1683359659412165"
                        helpText="Find it in Meta Events Manager → Data sources → your pixel. Digits only."
                        autoComplete="off"
                        error={errors.metaPixelId}
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        TikTok Pixel
                      </Text>
                      {!isPro && <Badge tone="info">PixelPro</Badge>}
                    </InlineStack>
                    <FormLayout>
                      <TextField
                        label="TikTok Pixel ID"
                        value={form.tiktokPixelId}
                        onChange={(v) => set("tiktokPixelId", v)}
                        placeholder="D2ABCD1234EFGH5678"
                        helpText="Find it in TikTok Events Manager → your pixel → Setup. Leave empty to skip."
                        autoComplete="off"
                        disabled={proLocked("tiktokPixelId")}
                        error={errors.tiktokPixelId}
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Google Tag
                      </Text>
                      {!isPro && <Badge tone="info">PixelPro</Badge>}
                    </InlineStack>
                    <FormLayout>
                      <TextField
                        label="Google Tag ID"
                        value={form.googleTagId}
                        onChange={(v) => set("googleTagId", v)}
                        placeholder="G-XXXXXXXXXX or AW-XXXXXXXXXX"
                        helpText="GA4 measurement ID (G-…) from Google Analytics, or Google Ads conversion ID (AW-…). Leave empty to skip."
                        autoComplete="off"
                        disabled={proLocked("googleTagId")}
                        error={errors.googleTagId}
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Snapchat Pixel
                      </Text>
                      {!isPro && <Badge tone="info">PixelPro</Badge>}
                    </InlineStack>
                    <FormLayout>
                      <TextField
                        label="Snapchat Pixel ID"
                        value={form.snapchatPixelId}
                        onChange={(v) => set("snapchatPixelId", v)}
                        placeholder="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                        helpText="Find it in Snapchat Ads Manager → Events Manager → your pixel. Leave empty to skip."
                        autoComplete="off"
                        disabled={proLocked("snapchatPixelId")}
                        error={errors.snapchatPixelId}
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>
              </BlockStack>
            </form>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      App embed
                    </Text>
                    {embedEnabled ? (
                      <Badge tone="success">Enabled</Badge>
                    ) : (
                      <Badge tone="critical">Not enabled</Badge>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {embedEnabled
                      ? "PixelPro Tracking is active on your theme. Pixels fire on the storefront."
                      : "Turn on the PixelPro Tracking embed in your theme editor to start firing pixels."}
                  </Text>
                  <Button
                    url={`https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/themes/current/editor?context=apps`}
                    target="_blank"
                  >
                    {embedEnabled ? "Open theme editor" : "Enable in theme editor"}
                  </Button>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Storefront status
                  </Text>
                  <PixelStatus settings={form} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Diagnostics
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    See live pixel events from your storefront and test each
                    pixel.
                  </Text>
                  <Button url="/app/diagnostics">Open diagnostics</Button>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    How to activate
                  </Text>
                  <Divider />
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      1. In your theme editor, open{" "}
                      <strong>Theme settings → App embeds</strong>.
                    </Text>
                    <Text as="p" variant="bodyMd">
                      2. Turn on <strong>PixelPro Tracking</strong> and save.
                    </Text>
                    <Text as="p" variant="bodyMd">
                      3. Pixels fire PageView, ViewContent, AddToCart,
                      InitiateCheckout and Purchase events automatically.
                    </Text>
                  </BlockStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
