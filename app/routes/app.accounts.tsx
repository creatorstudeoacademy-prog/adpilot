import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useState } from "react";
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
  TextField,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createMetaConnectParams } from "../lib/meta-oauth.server";
import { NavButton } from "../components/NavButton";
import { listAdAccounts } from "../lib/meta-ads.server";
import { decryptToken, encryptToken } from "../lib/token-vault.server";
import { Anim, Hero } from "../components/ui";

const GRAPH_VERSION = "v21.0";

async function fetchPageFollowers(pageId: string, token: string): Promise<number | null> {
  token = decryptToken(token);
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
  token = decryptToken(token);
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

  const [socialAccounts, adAccounts, userToken] = await Promise.all([
    prisma.socialAccount.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.adAccount.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.metaUserToken.findUnique({ where: { shop } }),
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

  // Map ad account -> Business Manager name (best-effort, one API call).
  // Checks both owned AND client ad accounts — agency/client accounts are
  // usually linked as clients, not owned, so owned_ad_accounts alone misses them.
  const businessByAdAccount = new Map<string, string>();
  if (userToken?.accessToken) {
    try {
      const { decryptToken } = await import("../lib/token-vault.server");
      const bRes = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/me/businesses?fields=id,name,owned_ad_accounts{id},client_ad_accounts{id}&access_token=${decryptToken(userToken.accessToken)}`,
      );
      const bData = (await bRes.json()) as {
        data?: Array<{
          name?: string;
          owned_ad_accounts?: { data?: Array<{ id?: string }> };
          client_ad_accounts?: { data?: Array<{ id?: string }> };
        }>;
      };
      for (const b of bData?.data ?? []) {
        const edges = [
          ...(b?.owned_ad_accounts?.data ?? []),
          ...(b?.client_ad_accounts?.data ?? []),
        ];
        for (const aa of edges) {
          if (aa?.id) businessByAdAccount.set(String(aa.id).replace("act_", ""), b.name ?? "");
        }
      }
    } catch {
      // best-effort: page still renders without BM labels
    }
  }
  let availableAdAccounts: Array<{ id: string; name: string; currency: string }> = [];
  let adAccountsError: string | null = null;
  if (userToken?.accessToken) {
    try {
      const existingIds = new Set(adAccounts.map((a) => a.adAccountId));
      const all = await listAdAccounts(userToken.accessToken);
      availableAdAccounts = all
        .filter((a) => !existingIds.has(a.id.replace("act_", "")))
        .map((a) => ({
          id: a.id.replace("act_", ""),
          name: a.name,
          currency: a.currency,
        }));
    } catch (e) {
      adAccountsError =
        e instanceof Error ? e.message : "Could not load ad accounts.";
    }
  }

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
      pixelId: a.pixelId,
      businessName: businessByAdAccount.get(a.adAccountId) ?? null,
      spend30d: spendResults[i].status === "fulfilled" ? spendResults[i].value : null,
      createdAt: a.createdAt.toISOString(),
    })),
    hasUserToken: !!userToken?.accessToken,
    availableAdAccounts,
    adAccountsError,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "connect_ad") {
    const adAccountId = String(formData.get("adAccountId") ?? "");
    const adAccountName = String(formData.get("adAccountName") ?? "");
    const currency = String(formData.get("currency") ?? "");
    const userToken = await prisma.metaUserToken.findUnique({ where: { shop } });
    if (!userToken?.accessToken || !adAccountId) {
      return json({ ok: false, message: "Connect Facebook first." });
    }
    await prisma.adAccount.create({
      data: {
        shop,
        adAccountId,
        adAccountName,
        accessToken: userToken.accessToken,
        currency,
      },
    });
    return json({ ok: true, message: `Ad account "${adAccountName}" connected.` });
  }

  if (intent === "disconnect_all_social") {
    await prisma.socialAccount.deleteMany({ where: { shop } });
    await prisma.metaUserToken.deleteMany({ where: { shop } });
    return json({ ok: true, message: "Facebook disconnected." });
  }

  if (intent === "disconnect_social") {
    const id = String(formData.get("id") ?? "");
    await prisma.socialAccount.deleteMany({ where: { id, shop } });
    return json({ ok: true, message: "Page disconnected." });
  }

  if (intent === "save_pixel") {
    const id = String(formData.get("id") ?? "");
    const pixelId = String(formData.get("pixelId") ?? "").trim();
    await prisma.adAccount.updateMany({
      where: { id, shop },
      data: { pixelId: pixelId || null },
    });
    return json({ ok: true, message: pixelId ? `Pixel ${pixelId} saved.` : "Pixel removed." });
  }

  if (intent === "save_manual_token") {
    const token = String(formData.get("token") ?? "").trim();
    if (!token) {
      return json({ ok: false, message: "Token is required." });
    }
    // Validate the token by fetching /me
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(token)}`
      );
      const data = await res.json();
      if (data.error) {
        return json({ ok: false, message: `Invalid token: ${data.error.message}` });
      }
    } catch {
      return json({ ok: false, message: "Could not validate token." });
    }
    await prisma.metaUserToken.upsert({
      where: { shop },
      create: { shop, accessToken: encryptToken(token) },
      update: { accessToken: encryptToken(token) },
    });
    return json({ ok: true, message: "Token saved. You can now connect ad accounts." });
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
    <div className="ap-card-hover">
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
    </div>
  );
}

function PixelCard({
  adAccountId,
  currentPixelId,
  busy,
}: {
  adAccountId: string;
  currentPixelId: string | null;
  busy: boolean;
}) {
  const [pixelId, setPixelId] = useState(currentPixelId ?? "");
  const [pixels, setPixels] = useState<Array<{ id: string; name: string }> | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const submit = useSubmit();
  const save = () => {
    const data = new FormData();
    data.set("intent", "save_pixel");
    data.set("id", adAccountId);
    data.set("pixelId", pixelId);
    submit(data, { method: "post" });
  };
  const fetchPixels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/ads/fetch-pixels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: adAccountId }),
      });
      const text = await res.text();
      let json: { ok?: boolean; pixels?: Array<{ id: string; name: string }>; message?: string } = {};
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Server returned an error (HTTP ${res.status}). Please reload and try again.`);
      }
      if (json.ok) {
        setPixels(json.pixels ?? []);
        if (!json.pixels || json.pixels.length === 0) {
          setFetchError("No pixels found on this ad account — check it has a pixel assigned in Business Manager, or enter the Pixel ID manually.");
        }
      } else {
        setFetchError(json.message ?? "Failed to fetch pixels.");
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to fetch pixels.");
    } finally {
      setFetching(false);
    }
  };
  return (
    <div className="ap-card-hover">
      <Card>
        <BlockStack gap="200">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Meta Pixel
            </Text>
          <div style={{ marginLeft: "auto" }}>
            <Button
              size="slim"
              disabled={busy || fetching}
              loading={fetching}
              onClick={fetchPixels}
            >
              Fetch from Business Manager
            </Button>
          </div>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          Connect a Meta Pixel for conversion tracking and better ad optimization.
          Click "Fetch from Business Manager" to auto-load your pixels, or enter manually.
        </Text>
        {fetchError && (
          <Text as="p" variant="bodySm" tone="critical">
            {fetchError}
          </Text>
        )}
        {pixels && pixels.length > 0 && (
          <BlockStack gap="100">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              Select a pixel:
            </Text>
            {pixels.map((p) => (
              <InlineStack key={p.id} gap="200" blockAlign="center">
                <Text as="p" variant="bodySm">
                  {p.name} ({p.id})
                </Text>
                <div style={{ marginLeft: "auto" }}>
                  <Button
                    size="slim"
                    variant={pixelId === p.id ? "primary" : "secondary"}
                    onClick={() => setPixelId(p.id)}
                  >
                    {pixelId === p.id ? "Selected" : "Select"}
                  </Button>
                </div>
              </InlineStack>
            ))}
          </BlockStack>
        )}
        {pixels && pixels.length === 0 && (
          <Text as="p" variant="bodySm" tone="subdued">
            No pixels found in this ad account's Business Manager.
          </Text>
        )}
        <InlineStack gap="200" blockAlign="end">
          <div style={{ flexGrow: 1 }}>
            <TextField
              label="Pixel ID"
              value={pixelId}
              onChange={setPixelId}
              placeholder="e.g. 1683359659412165"
              autoComplete="off"
            />
          </div>
          <Button disabled={busy} onClick={save}>
            Save Pixel
          </Button>
        </InlineStack>
        {currentPixelId && (
          <Text as="p" variant="bodySm" tone="success">
            ✓ Pixel {currentPixelId} connected
          </Text>
        )}
      </BlockStack>
    </Card>
    </div>
  );
}

function ManualTokenForm({ busy }: { busy: boolean }) {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const submit = useSubmit();
  const save = () => {
    const data = new FormData();
    data.set("intent", "save_manual_token");
    data.set("token", token);
    submit(data, { method: "post" });
  };
  return (
    <div className="ap-card-hover">
      <Card>
        <BlockStack gap="200">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Or paste a User Token manually
            </Text>
          <Button variant="plain" onClick={() => setShow(!show)}>
            {show ? "Hide" : "Show"}
          </Button>
        </InlineStack>
        {show && (
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" tone="subdued">
              Generate a token at{" "}
              <a
                href="https://developers.facebook.com/tools/explorer/"
                target="_blank"
                rel="noreferrer"
              >
                Graph API Explorer
              </a>{" "}
              — select app "AdPilot 2", add permissions: pages_show_list,
              pages_read_engagement, pages_manage_posts, instagram_basic,
              instagram_content_publish, ads_read, ads_management, business_management.
              Then click "Generate Access Token" and paste it below.
            </Text>
            <TextField
              label="User Access Token"
              value={token}
              onChange={setToken}
              placeholder="EAA..."
              autoComplete="off"
              type="password"
            />
            <InlineStack gap="200">
              <Button disabled={busy || !token.trim()} onClick={save}>
                Save Token
              </Button>
            </InlineStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
    </div>
  );
}

export default function AccountsPage() {
  const {
    shop,
    metaConfigured,
    metaConnectUrl,
    pages,
    instagrams,
    adAccounts,
    hasUserToken,
    availableAdAccounts,
    adAccountsError,
  } = useLoaderData<typeof loader>();
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

  const disconnectAllSocial = () => {
    if (
      window.confirm(
        "Disconnect all Facebook pages? You can reconnect anytime.",
      )
    ) {
      const data = new FormData();
      data.set("intent", "disconnect_all_social");
      submit(data, { method: "post" });
    }
  };

  const totalConnected = pages.length + instagrams.length + adAccounts.length;
  const fbConnected = pages.length > 0;

  return (
    <Page
      title="Connected Accounts"
      subtitle="Manage every Meta connection in one place"
    >
      <BlockStack gap="500">
        <Anim index={0}>
          <Hero
            title="Connected Accounts"
            subtitle="Manage every Meta connection in one place"
          />
        </Anim>
        {actionData && "ok" in actionData && actionData.ok && (
          <Anim index={1}>
            <Banner tone="success" onDismiss={() => {}}>
              {String(actionData.message ?? "Account disconnected.")}
            </Banner>
          </Anim>
        )}

        {!metaConfigured && (
          <Anim index={1}>
            <Banner tone="warning" title="Meta app not configured">
              The Meta app credentials (META_APP_ID / META_APP_SECRET) are not
              set yet. Add them to the app's environment variables to enable
              Facebook connect.
            </Banner>
          </Anim>
        )}

        {fbConnected && !hasUserToken && (
          <Anim index={1}>
            <Banner
              tone="warning"
              title="Reconnect Facebook to enable ad accounts"
            >
              <BlockStack gap="200">
                <Text as="p">
                  Your pages were connected before ad account support was added.
                  Reconnect Facebook once to enable ad account discovery — your
                  pages will stay connected.
                </Text>
                <InlineStack>
                  <Button
                    variant="primary"
                    url={metaConnectUrl}
                    target="_blank"
                  >
                    Reconnect Facebook
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Anim>
        )}

        <Anim index={2}>
          <div className="ap-card-hover">
            <Card>
              <InlineStack gap="300">
                {metaConfigured &&
                  (fbConnected ? (
                    <Button tone="critical" onClick={disconnectAllSocial} disabled={busy}>
                      Disconnect Facebook
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      url={metaConnectUrl}
                      target="_blank"
                    >
                      Connect Facebook
                    </Button>
                  ))}
                <NavButton url="/app/ads/connect">Connect Ad Account</NavButton>
              </InlineStack>
              <div style={{ marginTop: 12 }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Connect Facebook connects your Pages (Instagram Business accounts
                  linked to a Page come along automatically).
                </Text>
              </div>
              {!fbConnected && (
                <div style={{ marginTop: 16 }}>
                  <ManualTokenForm busy={busy} />
                </div>
              )}
            </Card>
          </div>
        </Anim>

        {totalConnected === 0 ? (
          <Anim index={3}>
            <div className="ap-card-hover">
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
            </div>
          </Anim>
        ) : (
          <Layout>
            <Layout.Section>
              <BlockStack gap="500">
                <Anim index={3}>
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
                </Anim>

                <Anim index={4}>
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
                </Anim>

                <Anim index={5}>
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
                        <BlockStack key={a.id} gap="200">
                          <AccountCard
                            title={a.adAccountName}
                            subtitle={`Ad account ${a.adAccountId} · ${a.currency}${a.businessName ? ` · ${a.businessName}` : ""}`}
                            stats={
                              a.spend30d != null
                                ? `$${a.spend30d.toFixed(2)} spend (30d)`
                                : undefined
                            }
                            connectedAt={a.createdAt}
                            busy={busy}
                            onDisconnect={() => disconnectAd(a.id)}
                          />
                          <PixelCard
                            adAccountId={a.id}
                            currentPixelId={a.pixelId}
                            busy={busy}
                          />
                        </BlockStack>
                      ))
                    )}
                    {/* Inline ad account discovery — connect without leaving this page */}
                    {hasUserToken && availableAdAccounts.length > 0 && (
                      <div className="ap-card-hover">
                        <Card>
                          <BlockStack gap="300">
                            <Text as="h2" variant="headingMd">
                              Available ad accounts
                            </Text>
                        {availableAdAccounts.map((a) => (
                          <InlineStack
                            key={a.id}
                            align="space-between"
                            blockAlign="center"
                          >
                            <Text as="p" variant="bodyMd">
                              {a.name} ({a.currency})
                            </Text>
                            <Button
                              variant="primary"
                              size="slim"
                              disabled={busy}
                              onClick={() => {
                                const data = new FormData();
                                data.set("intent", "connect_ad");
                                data.set("adAccountId", a.id);
                                data.set("adAccountName", a.name);
                                data.set("currency", a.currency);
                                submit(data, { method: "post" });
                              }}
                            >
                              Connect
                            </Button>
                          </InlineStack>
                        ))}
                      </BlockStack>
                        </Card>
                      </div>
                    )}
                    {hasUserToken && adAccountsError && (
                      <Anim index={1}>
                        <Banner tone="warning">{adAccountsError}</Banner>
                      </Anim>
                    )}
                  </BlockStack>
                </Anim>
              </BlockStack>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Anim index={4}>
                <div className="ap-card-hover">
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
                </div>
              </Anim>
            </Layout.Section>
          </Layout>
        )}
      </BlockStack>
    </Page>
  );
}
