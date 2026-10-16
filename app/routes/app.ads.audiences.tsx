import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
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
  DataTable,
  Grid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  createEngagementAudience,
  createInterestAudience,
  createLookalikeAudience,
  createVideoAudience,
  createWebsiteAudience,
  getAdPixels,
} from "../lib/meta-ads.server";
import { deduct, getWallet, refund } from "../lib/wallet.server";
import {
  LOOKALIKE_AUDIENCE_FEE,
  STANDALONE_AUDIENCE_FEE,
} from "../lib/pricing";

const AUDIENCE_TYPES = [
  {
    id: "website",
    name: "Website Visitors",
    description: "Retarget people who visited your website.",
    fee: STANDALONE_AUDIENCE_FEE,
  },
  {
    id: "video",
    name: "Video Viewers",
    description: "People who watched your Page's videos.",
    fee: STANDALONE_AUDIENCE_FEE,
  },
  {
    id: "engagement",
    name: "Page Engagers",
    description: "People who engaged with your Facebook Page.",
    fee: STANDALONE_AUDIENCE_FEE,
  },
  {
    id: "interest",
    name: "Interest-based",
    description: "Cold audience by interests, country and age.",
    fee: STANDALONE_AUDIENCE_FEE,
  },
  {
    id: "lookalike",
    name: "Lookalike",
    description: "Find new people similar to an existing audience.",
    fee: LOOKALIKE_AUDIENCE_FEE,
  },
] as const;

const COUNTRY_OPTIONS = [
  { label: "United States", value: "US" },
  { label: "United Kingdom", value: "GB" },
  { label: "Canada", value: "CA" },
  { label: "Australia", value: "AU" },
  { label: "Germany", value: "DE" },
  { label: "France", value: "FR" },
  { label: "India", value: "IN" },
  { label: "Bangladesh", value: "BD" },
  { label: "United Arab Emirates", value: "AE" },
  { label: "Saudi Arabia", value: "SA" },
];

const RETENTION_OPTIONS = [
  { label: "30 days", value: "30" },
  { label: "60 days", value: "60" },
  { label: "90 days", value: "90" },
  { label: "180 days", value: "180" },
];

const WATCH_OPTIONS = [
  { label: "25% watched", value: "25" },
  { label: "50% watched", value: "50" },
  { label: "75% watched", value: "75" },
  { label: "95% watched", value: "95" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [adAccounts, wallet, pages, audiences] = await Promise.all([
    prisma.adAccount.findMany({ where: { shop } }),
    getWallet(shop),
    prisma.socialAccount.findMany({
      where: { shop, platform: "facebook" },
      select: { pageId: true, pageName: true },
    }),
    prisma.audience.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      include: { adAccount: { select: { adAccountName: true } } },
    }),
  ]);

  if (adAccounts.length === 0) return redirect("/app/ads/connect");

  // Pixels per ad account (for the website-audience pixel selector).
  const pixelsByAccount: Record<string, Array<{ id: string; name: string }>> = {};
  await Promise.all(
    adAccounts.map(async (a) => {
      try {
        pixelsByAccount[a.id] = await getAdPixels(a.adAccountId, a.accessToken);
      } catch {
        pixelsByAccount[a.id] = [];
      }
    }),
  );

  return json({
    adAccounts: adAccounts.map((a) => ({
      id: a.id,
      adAccountId: a.adAccountId,
      adAccountName: a.adAccountName,
      currency: a.currency,
    })),
    walletBalance: wallet.balance,
    pages,
    pixelsByAccount,
    audiences: audiences.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      status: a.status,
      approxCount: a.approxCount,
      adAccountName: a.adAccount.adAccountName,
      createdAt: a.createdAt.toISOString(),
      error: a.error,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  const adAccountDbId = String(form.get("adAccountDbId") ?? "");
  const type = String(form.get("type") ?? "");
  const name = String(form.get("name") ?? "").trim();

  const typeDef = AUDIENCE_TYPES.find((t) => t.id === type);
  if (!typeDef) return json({ ok: false, error: "Pick an audience type." });
  if (!name) return json({ ok: false, error: "Give your audience a name." });

  const fee = typeDef.fee;

  const adAccount = await prisma.adAccount.findFirst({
    where: { id: adAccountDbId, shop },
  });
  if (!adAccount) return json({ ok: false, error: "Ad account not found." });

  const wallet = await getWallet(shop);
  if (wallet.balance < fee) {
    return redirect("/app/wallet?need=" + fee.toFixed(2));
  }

  const audience = await prisma.audience.create({
    data: {
      shop,
      adAccountId: adAccount.id,
      name,
      type,
      status: "active",
      publishFee: fee,
      config: JSON.stringify(Object.fromEntries(form)),
    },
  });

  await deduct(shop, fee, `Audience creation fee (${typeDef.name}): ${name}`, audience.id);

  try {
    let metaId: string | null = null;
    let subtype: string | null = null;

    if (type === "website") {
      const pixelId = String(form.get("pixelId") ?? "");
      if (!pixelId) throw new Error("Select a Meta pixel for website tracking.");
      const retentionDays = parseInt(String(form.get("retentionDays") ?? "180"), 10);
      metaId = await createWebsiteAudience(adAccount.adAccountId, adAccount.accessToken, {
        name,
        pixelId,
        retentionDays,
        urlContains: String(form.get("urlContains") ?? "").trim() || undefined,
      });
      subtype = "WEBSITE";
    } else if (type === "video") {
      const page = await prisma.socialAccount.findFirst({
        where: { shop, platform: "facebook" },
      });
      if (!page) throw new Error("Connect a Facebook Page first.");
      metaId = await createVideoAudience(adAccount.adAccountId, adAccount.accessToken, {
        name,
        pageId: page.pageId,
        watchPercent: parseInt(String(form.get("watchPercent") ?? "50"), 10),
        retentionDays: parseInt(String(form.get("retentionDays") ?? "180"), 10),
      });
      subtype = "VIDEO";
    } else if (type === "engagement") {
      const page = await prisma.socialAccount.findFirst({
        where: { shop, platform: "facebook" },
      });
      if (!page) throw new Error("Connect a Facebook Page first.");
      metaId = await createEngagementAudience(adAccount.adAccountId, adAccount.accessToken, {
        name,
        pageId: page.pageId,
        retentionDays: parseInt(String(form.get("retentionDays") ?? "180"), 10),
      });
      subtype = "ENGAGEMENT";
    } else if (type === "interest") {
      const keywords = String(form.get("interestKeywords") ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (keywords.length === 0) throw new Error("Enter at least one interest keyword.");
      const result = await createInterestAudience(
        adAccount.adAccountId,
        adAccount.accessToken,
        {
          name,
          country: String(form.get("country") ?? "US"),
          ageMin: parseInt(String(form.get("ageMin") ?? "25"), 10) || 25,
          ageMax: parseInt(String(form.get("ageMax") ?? "64"), 10) || 64,
          interestKeywords: keywords,
        },
      );
      metaId = result.id;
      subtype = "SAVED";
    } else if (type === "lookalike") {
      const sourceDbId = String(form.get("sourceAudienceDbId") ?? "");
      const source = await prisma.audience.findFirst({
        where: { id: sourceDbId, shop },
      });
      if (!source?.metaAudienceId) throw new Error("Pick a source audience first.");
      metaId = await createLookalikeAudience(
        adAccount.adAccountId,
        adAccount.accessToken,
        {
          name,
          sourceAudienceId: source.metaAudienceId,
          country: String(form.get("country") ?? "US"),
          ratio: 0.01,
        },
      );
      subtype = "LOOKALIKE";
    }

    await prisma.audience.update({
      where: { id: audience.id },
      data: { metaAudienceId: metaId, subtype, status: "active" },
    });

    return redirect("/app/ads/audiences?created=1");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Audience creation failed.";
    await refund(shop, fee, `Refund: audience creation failed for ${name}`, audience.id);
    await prisma.audience.update({
      where: { id: audience.id },
      data: { status: "failed", error: message },
    });
    return json({ ok: false, error: message });
  }
};

export default function AudienceManager() {
  const { adAccounts, walletBalance, pixelsByAccount, audiences } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  const [showCreator, setShowCreator] = useState(false);
  const [adAccountDbId, setAdAccountDbId] = useState(adAccounts[0]?.id ?? "");
  const [type, setType] = useState<string>("website");
  const [name, setName] = useState("");
  const [pixelId, setPixelId] = useState("");
  const [retentionDays, setRetentionDays] = useState("180");
  const [urlContains, setUrlContains] = useState("");
  const [watchPercent, setWatchPercent] = useState("50");
  const [country, setCountry] = useState("US");
  const [ageMin, setAgeMin] = useState("25");
  const [ageMax, setAgeMax] = useState("64");
  const [interestKeywords, setInterestKeywords] = useState("");
  const [sourceAudienceDbId, setSourceAudienceDbId] = useState("");

  const typeDef = AUDIENCE_TYPES.find((t) => t.id === type)!;
  const insufficient = typeDef.fee > walletBalance;
  const pixels = pixelsByAccount[adAccountDbId] ?? [];
  const usableSources = audiences.filter((a) => a.metaAudienceId && a.status === "active");

  const create = () => {
    const fd = new FormData();
    fd.append("adAccountDbId", adAccountDbId);
    fd.append("type", type);
    fd.append("name", name);
    fd.append("pixelId", pixelId);
    fd.append("retentionDays", retentionDays);
    fd.append("urlContains", urlContains);
    fd.append("watchPercent", watchPercent);
    fd.append("country", country);
    fd.append("ageMin", ageMin);
    fd.append("ageMax", ageMax);
    fd.append("interestKeywords", interestKeywords);
    fd.append("sourceAudienceDbId", sourceAudienceDbId);
    submit(fd, { method: "post" });
  };

  const rows = audiences.map((a) => [
    a.name,
    <Badge key={a.id}>{a.type}</Badge>,
    a.adAccountName,
    a.status === "active" ? (
      <Badge key={a.id + "-s"} tone="success">Active</Badge>
    ) : (
      <Badge key={a.id + "-s"} tone="critical">Failed</Badge>
    ),
    a.approxCount != null ? a.approxCount.toLocaleString() : "—",
    new Date(a.createdAt).toLocaleDateString(),
  ]);

  return (
    <Page
      title="Audience Manager"
      subtitle="Build retargeting & prospecting audiences once, reuse everywhere"
      primaryAction={{
        content: showCreator ? "Close" : "Create audience",
        onAction: () => setShowCreator((v) => !v),
      }}
      backAction={{ content: "Ads", url: "/app/ads" }}
    >
      <BlockStack gap="500">
        {actionData && !actionData.ok && (
          <Banner title="Couldn't create the audience" tone="critical">
            {actionData.error}
          </Banner>
        )}

        {showCreator && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                New audience
              </Text>
              <Select
                label="Ad account"
                options={adAccounts.map((a) => ({
                  label: `${a.adAccountName} (${a.currency})`,
                  value: a.id,
                }))}
                value={adAccountDbId}
                onChange={setAdAccountDbId}
              />

              <Text as="p" variant="headingSm">
                Audience type
              </Text>
              <Grid>
                {AUDIENCE_TYPES.map((t) => (
                  <Grid.Cell key={t.id} columnSpan={{ xs: 6, sm: 3, md: 2, lg: 4, xl: 4 }}>
                    <Card>
                      <div
                        onClick={() => setType(t.id)}
                        style={{
                          cursor: "pointer",
                          border: type === t.id ? "2px solid #008060" : "2px solid transparent",
                          borderRadius: 8,
                          padding: 4,
                        }}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">
                            {t.name}
                          </Text>
                          <Text as="p" tone="subdued" variant="bodySm">
                            {t.description}
                          </Text>
                          <Text as="p" variant="bodySm">
                            ${t.fee.toFixed(2)}
                          </Text>
                        </BlockStack>
                      </div>
                    </Card>
                  </Grid.Cell>
                ))}
              </Grid>

              <TextField
                label="Audience name"
                value={name}
                onChange={setName}
                autoComplete="off"
                placeholder="e.g. Website visitors 180d"
              />

              {type === "website" && (
                <BlockStack gap="400">
                  {pixels.length > 0 ? (
                    <Select
                      label="Meta pixel"
                      options={pixels.map((p) => ({ label: p.name, value: p.id }))}
                      value={pixelId}
                      onChange={setPixelId}
                      placeholder="Select a pixel"
                    />
                  ) : (
                    <Banner tone="warning">
                      No pixel found on this ad account. Install a Meta pixel to
                      build website audiences.
                    </Banner>
                  )}
                  <TextField
                    label="URL contains (optional)"
                    value={urlContains}
                    onChange={setUrlContains}
                    autoComplete="off"
                    placeholder="/products — leave empty for all visitors"
                  />
                  <Select
                    label="Retention"
                    options={RETENTION_OPTIONS}
                    value={retentionDays}
                    onChange={setRetentionDays}
                  />
                </BlockStack>
              )}

              {type === "video" && (
                <BlockStack gap="400">
                  <Select
                    label="Watch threshold"
                    options={WATCH_OPTIONS}
                    value={watchPercent}
                    onChange={setWatchPercent}
                  />
                  <Select
                    label="Retention"
                    options={RETENTION_OPTIONS}
                    value={retentionDays}
                    onChange={setRetentionDays}
                  />
                </BlockStack>
              )}

              {type === "engagement" && (
                <Select
                  label="Retention"
                  options={RETENTION_OPTIONS}
                  value={retentionDays}
                  onChange={setRetentionDays}
                />
              )}

              {type === "interest" && (
                <BlockStack gap="400">
                  <TextField
                    label="Interest keywords (comma-separated)"
                    value={interestKeywords}
                    onChange={setInterestKeywords}
                    autoComplete="off"
                    placeholder="fitness, yoga, running"
                    helpText="Matched to Meta's interest taxonomy automatically."
                  />
                  <Select
                    label="Country"
                    options={COUNTRY_OPTIONS}
                    value={country}
                    onChange={setCountry}
                  />
                  <Grid>
                    <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
                      <TextField
                        label="Min age"
                        type="number"
                        value={ageMin}
                        onChange={setAgeMin}
                        autoComplete="off"
                      />
                    </Grid.Cell>
                    <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
                      <TextField
                        label="Max age"
                        type="number"
                        value={ageMax}
                        onChange={setAgeMax}
                        autoComplete="off"
                      />
                    </Grid.Cell>
                  </Grid>
                </BlockStack>
              )}

              {type === "lookalike" && (
                <BlockStack gap="400">
                  {usableSources.length > 0 ? (
                    <Select
                      label="Source audience"
                      options={usableSources.map((a) => ({
                        label: `${a.name} (${a.type})`,
                        value: a.id,
                      }))}
                      value={sourceAudienceDbId}
                      onChange={setSourceAudienceDbId}
                      placeholder="Select a source audience"
                    />
                  ) : (
                    <Banner tone="warning">
                      Create a website, video or engagement audience first — a
                      lookalike needs a source.
                    </Banner>
                  )}
                  <Select
                    label="Country"
                    options={COUNTRY_OPTIONS}
                    value={country}
                    onChange={setCountry}
                  />
                  <Text as="p" tone="subdued">
                    Similarity: 1% (closest matches).
                  </Text>
                </BlockStack>
              )}

              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="p" tone="subdued">
                      Creation fee ({typeDef.name})
                    </Text>
                    <Text as="p">${typeDef.fee.toFixed(2)}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p" tone="subdued">
                      Wallet balance after
                    </Text>
                    <Text as="p">
                      ${(walletBalance - typeDef.fee).toFixed(2)}
                    </Text>
                  </InlineStack>
                  {insufficient && (
                    <Banner tone="warning">
                      Insufficient wallet balance — top up first.
                    </Banner>
                  )}
                  <Text as="p" variant="bodySm" tone="critical">
                    This action is irreversible. The fee will be deducted
                    immediately and cannot be refunded.
                  </Text>
                </BlockStack>
              </Card>

              <InlineStack align="end">
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!name.trim()}
                  onClick={create}
                >
                  {insufficient
                    ? "Top up & create"
                    : `Create audience ($${typeDef.fee.toFixed(2)})`}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Your audiences
                </Text>
                {audiences.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No audiences yet. Create your first audience to power
                    retargeting in the ad creator and funnels.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                    headings={["Name", "Type", "Ad account", "Status", "Size", "Created"]}
                    rows={rows}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
