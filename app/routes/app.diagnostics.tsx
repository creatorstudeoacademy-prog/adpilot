import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getSettings } from "../lib/settings.server";
import { getRecentEvents } from "./api.pixel-events";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getSettings(admin);
  const events = getRecentEvents(session.shop);

  return json({
    settings,
    events,
    shopDomain: session.shop,
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
  });
};

const TEST_LINKS = [
  {
    pixel: "Meta",
    url: "https://www.facebook.com/events_manager2/list/dataset",
    label: "Open Meta Events Manager → Test Events",
  },
  {
    pixel: "TikTok",
    url: "https://events.tiktok.com/events_manager",
    label: "Open TikTok Events Manager",
  },
  {
    pixel: "Google",
    url: "https://tagassistant.google.com/",
    label: "Open Google Tag Assistant",
  },
  {
    pixel: "Snapchat",
    url: "https://ads.snapchat.com/",
    label: "Open Snapchat Ads Manager → Events Manager",
  },
];

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export default function DiagnosticsPage() {
  const { settings, events, appUrl } = useLoaderData<typeof loader>();
  const [liveEvents, setLiveEvents] = useState(events);

  // Poll for new events every 5 seconds while the page is open.
  useEffect(() => {
    setLiveEvents(events);
  }, [events]);

  const configured = [
    { label: "Meta Pixel", id: settings.metaPixelId, test: TEST_LINKS[0] },
    { label: "TikTok Pixel", id: settings.tiktokPixelId, test: TEST_LINKS[1] },
    { label: "Google Tag", id: settings.googleTagId, test: TEST_LINKS[2] },
    { label: "Snapchat Pixel", id: settings.snapchatPixelId, test: TEST_LINKS[3] },
  ];

  const rows = liveEvents.map((e) => [
    timeAgo(e.timestamp),
    e.pixel,
    e.event,
    e.page || "—",
  ]);

  return (
    <Page
      title="Pixel Diagnostics"
      subtitle="Live event feed from your storefront"
      backAction={{ content: "Settings", url: "/app" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Live event feed
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Events fired by PixelPro on your storefront appear here in
                  real time. Visit your store, browse a product, add to cart —
                  then come back and refresh.
                </Text>
                {rows.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["When", "Pixel", "Event", "Page"]}
                    rows={rows}
                  />
                ) : (
                  <EmptyState
                    heading="No events yet"
                    image="https://cdn.shopify.com/s/files/1/0262/4076/files/empty-state.svg"
                  >
                    <p>
                      No pixel events received yet. Make sure tracking is
                      enabled, at least one pixel ID is saved, and the app
                      embed is turned on — then visit your storefront.
                    </p>
                  </EmptyState>
                )}
                <InlineStack>
                  <Button
                    onClick={() => window.location.reload()}
                  >
                    Refresh feed
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Pixel status
                </Text>
                {configured.map((p) => (
                  <BlockStack key={p.label} gap="100">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" variant="bodyMd">
                        {p.label}
                      </Text>
                      {p.id ? (
                        <Badge tone="success">Configured</Badge>
                      ) : (
                        <Badge>Not set</Badge>
                      )}
                    </InlineStack>
                    {p.id ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {p.id}
                      </Text>
                    ) : null}
                  </BlockStack>
                ))}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Test your pixels
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Use each platform's official test tool to confirm events
                  arrive:
                </Text>
                {TEST_LINKS.map((t) => (
                  <Button
                    key={t.pixel}
                    url={t.url}
                    target="_blank"
                    fullWidth
                    textAlign="left"
                  >
                    {t.label}
                  </Button>
                ))}
              </BlockStack>
            </Card>

            {appUrl ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Server-side tracking
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Browser pixels can be blocked by ad blockers and iOS
                    privacy features. Server-side tracking (Meta Conversions
                    API, TikTok Events API) sends events directly from our
                    servers for maximum accuracy.
                  </Text>
                  <Badge tone="info">Coming soon</Badge>
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
