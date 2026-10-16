import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
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
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createMetaConnectParams } from "../lib/meta-oauth.server";

const GRAPH_VERSION = "v21.0";

async function fetchPageFollowers(pageId: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=followers_count&access_token=${token}`,
    );
    const data = await res.json();
    return typeof data.followers_count === "number" ? data.followers_count : null;
  } catch {
    return null;
  }
}

async function fetchAdSpend(adAccountId: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/act_${adAccountId}/insights?fields=spend&date_preset=last_30d&access_token=${token}`,
    );
    const data = await res.json();
    const spend = parseFloat(data?.data?.[0]?.spend ?? "");
    return Number.isFinite(spend) ? spend : null;
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [socialAccounts, adAccounts] = await Promise.all([
    prisma.socialAccount.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.adAccount.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const metaAppId = process.env.META_APP_ID ?? "";

  const pages = socialAccounts.filter((a) => a.platform === "facebook");
  const instagrams = socialAccounts.filter((a) => a.platform === "instagram");

  // Best-effort stats from the Meta API.
  const followerResults = await Promise.allSettled(
    pages.map((p) => fetchPageFollowers(p.pageId, p.accessToken)),
  );
  const spendResults = await Promise.allSettled(
    adAccounts.map((a) => fetchAdSpend(a.adAccountId, a.accessToken)),
  );

  return json({
    shop,
    // Signed, short-lived connect URL — minted here (authenticated session)
    // so the top-level OAuth tab can verify it without a Shopify session.
    metaConnectUrl: `/auth/meta?${createMetaConnectParams(shop)}`,
    metaConfigured: metaAppId.length > 0,
    pages: pages.map((a, i) => ({
      id: a.id,
      pageName: a.pageName,
      pageId: a.pageId,
      followers:
        followerResults[i].status === "fulfilled" ? followerResults[i].value : null,
      createdAt: a.createdAt.toISOString(),
    })),
    instagrams: instagrams.map((a) => ({
      id: a.id,
      pageName: a.pageName,
      instagramId: a.instagramId,
      createdAt: a.createdAt.toISOString(),
    })),
    adAccounts: adAccounts.map((a, i) => ({
      id: a.id,
      adAccountName: a.adAccountName,
      adAccountId: a.adAccountId,
      currency: a.currency,
      spend30d: spendResults[i].status === "fulfilled" ? spendResults[i].value : null,
      createdAt: a.createdAt.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "disconnect_social") {
    const id = String(formData.get("id") ?? "");
    await prisma.socialAccount.deleteMany({ where: { id, shop } });
    return json({ ok: true, message: "Page disconnected." });
  }

  if (intent === "disconnect_ad") {
    const id = String(formData.get("id") ?? "");
    await prisma.adAccount.deleteMany({ where: { id, shop } });
    return json({ ok: true, message: "Ad account disconnected." });
  }

  return json({ ok: false });
};

function AccountCard({
  title,
  subtitle,
  stats,
  connectedAt,
  busy,
  onDisconnect,
}: {
  title: string;
  subtitle: string;
  stats?: string;
  connectedAt: string;
  busy: boolean;
  onDisconnect: () => void;
}) {
  return (
    <Card>
      <InlineStack align="space-between" blockAlign="center">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">
              {title}
            </Text>
            <Badge tone="success">Connected</Badge>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {subtitle}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Connected {new Date(connectedAt).toLocaleDateString()}
            {stats ? ` · ${stats}` : ""}
          </Text>
        </BlockStack>
        <Button
          tone="critical"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Disconnect "${title}"? You can reconnect anytime.`)) {
              onDisconnect();
            }
          }}
        >
          Disconnect
        </Button>
      </InlineStack>
    </Card>
  );
}

export default function AccountsPage() {
  const { shop, metaConfigured, metaConnectUrl, pages, instagrams, adAccounts } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state === "submitting";

  const disconnectSocial = (id: string) => {
    const data = new FormData();
    data.set("intent", "disconnect_social");
    data.set("id", id);
    submit(data, { method: "post" });
  };

  const disconnectAd = (id: string) => {
    const data = new FormData();
    data.set("intent", "disconnect_ad");
    data.set("id", id);
    submit(data, { method: "post" });
  };

  const totalConnected = pages.length + instagrams.length + adAccounts.length;

  return (
    <Page
      title="Connected Accounts"
      subtitle="Manage every Meta connection in one place"
    >
      <BlockStack gap="500">
        {actionData && "ok" in actionData && actionData.ok && (
          <Banner tone="success" onDismiss={() => {}}>
            {String(actionData.message ?? "Account disconnected.")}
          </Banner>
        )}

        {!metaConfigured && (
          <Banner tone="warning" title="Meta app not configured">
            The Meta app credentials (META_APP_ID / META_APP_SECRET) are not
            set yet. Add them to the app's environment variables to enable
            Facebook connect.
          </Banner>
        )}

        <Card>
          <InlineStack gap="300">
            {metaConfigured && (
              <Button
                variant="primary"
                url={metaConnectUrl}
                target="_blank"
              >
                Connect Facebook
              </Button>
            )}
            <Button url="/app/ads/connect">Connect Ad Account</Button>
          </InlineStack>
          <div style={{ marginTop: 12 }}>
            <Text as="p" variant="bodySm" tone="subdued">
              Connect Facebook connects your Pages (Instagram Business accounts
              linked to a Page come along automatically).
            </Text>
          </div>
        </Card>

        {totalConnected === 0 ? (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                No accounts connected yet
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Connect your Facebook Page to publish posts and reels, and
                connect an ad account to run campaigns and build audiences.
              </Text>
            </BlockStack>
          </Card>
        ) : (
          <Layout>
            <Layout.Section>
              <BlockStack gap="500">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Facebook Pages ({pages.length})
                  </Text>
                  {pages.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No Pages connected.
                    </Text>
                  ) : (
                    pages.map((p) => (
                      <AccountCard
                        key={p.id}
                        title={p.pageName}
                        subtitle={`Facebook Page · ${p.pageId}`}
                        stats={
                          p.followers != null
                            ? `${p.followers.toLocaleString()} followers`
                            : undefined
                        }
                        connectedAt={p.createdAt}
                        busy={busy}
                        onDisconnect={() => disconnectSocial(p.id)}
                      />
                    ))
                  )}
                </BlockStack>

                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Instagram Accounts ({instagrams.length})
                  </Text>
                  {instagrams.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No Instagram accounts connected. Link an Instagram Business
                      account to a Facebook Page to connect it.
                    </Text>
                  ) : (
                    instagrams.map((a) => (
                      <AccountCard
                        key={a.id}
                        title={a.pageName}
                        subtitle={`Instagram · ${a.instagramId ?? ""}`}
                        connectedAt={a.createdAt}
                        busy={busy}
                        onDisconnect={() => disconnectSocial(a.id)}
                      />
                    ))
                  )}
                </BlockStack>

                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Ad Accounts ({adAccounts.length})
                  </Text>
                  {adAccounts.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No ad accounts connected.
                    </Text>
                  ) : (
                    adAccounts.map((a) => (
                      <AccountCard
                        key={a.id}
                        title={a.adAccountName}
                        subtitle={`Ad account ${a.adAccountId} · ${a.currency}`}
                        stats={
                          a.spend30d != null
                            ? `$${a.spend30d.toFixed(2)} spend (30d)`
                            : undefined
                        }
                        connectedAt={a.createdAt}
                        busy={busy}
                        onDisconnect={() => disconnectAd(a.id)}
                      />
                    ))
                  )}
                </BlockStack>
              </BlockStack>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    What you get
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Pages unlock social posting (posts, reels, video). Ad
                    accounts unlock the Ads Manager, full-funnel campaigns and
                    the Audience Manager.
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Disconnecting removes the account from AdPilot. You can
                    reconnect anytime.
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}
      </BlockStack>
    </Page>
  );
}
