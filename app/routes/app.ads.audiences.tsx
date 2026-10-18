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
  Box,
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
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import { logActivity } from "../lib/activity.server";
import {
  AI_AUDIENCE_FEE,
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

import { COUNTRIES as COUNTRY_OPTIONS } from "../lib/countries";
import { Anim, Hero } from "../components/ui";

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

  const intent = String(form.get("intent") ?? "create");

  // Delete an audience (DB record; best-effort Meta cleanup if it was published).
  if (intent === "delete") {
    const audienceId = String(form.get("audienceId") ?? "");
    const rec = await prisma.audience.findFirst({ where: { id: audienceId, shop } });
    if (!rec) return json({ ok: false, error: "Audience not found." });
    if (rec.metaAudienceId && rec.status === "active") {
      try {
        const adAccount = await prisma.adAccount.findFirst({
          where: { id: rec.adAccountId, shop },
        });
        if (adAccount) {
          const { deleteAudience } = await import("../lib/meta-ads.server");
          await deleteAudience(rec.metaAudienceId, adAccount.accessToken);
        }
      } catch {
        // Meta delete is best-effort; the DB record is the source of truth here.
      }
    }
    await prisma.audience.delete({ where: { id: rec.id } });
    await logActivity({ shop, action: "audience_deleted", detail: rec.name, feeCharged: 0 });
    return json({ ok: true, message: `Deleted "${rec.name}".` });
  }

  // ✨ AI Auto-create audience: analyzes page + objective, generates targeting via AI
  if (intent === "auto_create") {
    const adAccountDbId = String(form.get("adAccountDbId") ?? "");
    const objective = String(form.get("objective") ?? "TRAFFIC");
    const name = String(form.get("name") ?? "").trim() || `AI Audience - ${objective}`;

    const adAccount = await prisma.adAccount.findFirst({
      where: { id: adAccountDbId, shop },
    });
    if (!adAccount) return json({ ok: false, error: "Select an ad account." });

    // Wallet check BEFORE the AI call — don't burn owner AI cost for
    // merchants who can't pay.
    const fee = AI_AUDIENCE_FEE;
    const wallet = await getWallet(shop);
    if (!isFreeShop(shop) && wallet.balance < fee) {
      return redirect("/app/wallet?need=" + fee.toFixed(2));
    }

    // Get page info for AI context
    const page = await prisma.socialAccount.findFirst({
      where: { shop, platform: "facebook" },
    });

    // Get AI-generated targeting
    let targeting: {
      country: string;
      ageMin: number;
      ageMax: number;
      interestKeywords: string[];
      description: string;
    };
    try {
      const { generateWithProvider, resolveProvidersAsync } = await import("../lib/ai.server");
      const providers = await resolveProvidersAsync();
      if (providers.length === 0) {
        throw new Error("No AI provider configured. Add an AI in the AI Control Panel.");
      }
      const pageContext = page
        ? `Facebook Page: ${page.pageName} (ID: ${page.pageId})`
        : "No Facebook Page connected";
      const prompt = `You are a Meta ads targeting expert. Generate optimal audience targeting for a Facebook/Instagram ad campaign.

Context:
- ${pageContext}
- Campaign Objective: ${objective}
- Business: E-commerce store selling trending products

Generate targeting as JSON with these exact fields:
{
  "country": "US",
  "ageMin": 18,
  "ageMax": 65,
  "interestKeywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "description": "Brief explanation of why this targeting works for the objective"
}

Rules:
- For TRAFFIC: broad interests, ages 18-65, focus on discovery
- For ENGAGEMENT: interests aligned with viral/shareable content, ages 18-44
- For SALES: purchase-intent interests, ages 25-54, focus on buyers
- For AWARENESS: very broad, ages 18-65, mass appeal interests
- Include 5 specific, relevant interest keywords (not generic like "shopping")
- Country: US (primary market)

Return ONLY the JSON, no other text.`;

      const aiResult = await generateWithProvider(providers[0], prompt, {
        maxTokens: 500,
        temperature: 0.7,
      });
      const jsonMatch = aiResult.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("AI did not return valid targeting.");
      targeting = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return json({
        ok: false,
        error: e instanceof Error ? e.message : "AI targeting generation failed.",
      });
    }

    // Create the audience in DB
    const audience = await prisma.audience.create({
      data: {
        shop,
        adAccountId: adAccount.id,
        name,
        type: "interest",
        status: "draft", // flipped to "active" only after payment + Meta success
        publishFee: fee,
        config: JSON.stringify({
          ...targeting,
          autoCreated: true,
          objective,
        }),
      },
    });

    await deduct(shop, fee, `AI auto-audience: ${name}`, audience.id);

    try {
      const result = await createInterestAudience(
        adAccount.adAccountId,
        adAccount.accessToken,
        {
          name,
          country: targeting.country,
          ageMin: targeting.ageMin,
          ageMax: targeting.ageMax,
          interestKeywords: targeting.interestKeywords,
        },
      );
      await prisma.audience.update({
        where: { id: audience.id },
        data: { metaAudienceId: result.id, subtype: "SAVED", status: "active" },
      });
      await logActivity(shop, `AI created audience: ${name}`);
      return json({
        ok: true,
        message: `AI created audience "${name}" with ${targeting.interestKeywords.length} interests. ${targeting.description}`,
        audienceId: audience.id,
      });
    } catch (e) {
      await prisma.audience.update({
        where: { id: audience.id },
        data: { status: "failed" },
      });
      await refund(shop, fee, `Refund: AI audience creation failed (${name})`, audience.id);
      return json({
        ok: false,
        error: e instanceof Error ? e.message : "Meta API failed to create audience.",
      });
    }
  }

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
  // Free shops (owner's own stores) skip the balance check.
  if (!isFreeShop(shop) && wallet.balance < fee) {
    return redirect("/app/wallet?need=" + fee.toFixed(2));
  }

  const audience = await prisma.audience.create({
    data: {
      shop,
      adAccountId: adAccount.id,
      name,
      type,
      status: "draft", // flipped to "active" only after payment + Meta success
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
    logActivity({
      shop,
      action: "audience_create",
      detail: `audience:${audience.id} type:${type} name:${name} fee:${fee.toFixed(2)}`,
      feeCharged: isFreeShop(shop) ? 0 : fee,
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

  const deleteAudienceRow = (audienceId: string) => {
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("audienceId", audienceId);
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
    <Button
      key={a.id + "-del"}
      variant="plain"
      tone="critical"
      disabled={busy}
      onClick={() => void deleteAudienceRow(a.id)}
    >
      Delete
    </Button>,
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
        <Anim index={0}>
          <Hero
            title="Audience Manager"
            subtitle="Build retargeting & prospecting audiences once, reuse everywhere"
          />
        </Anim>
        {actionData && !actionData.ok && (
          <Anim index={1}>
            <Banner title="Couldn't create the audience" tone="critical">
              {actionData.error}
            </Banner>
          </Anim>
        )}
        {actionData?.ok && actionData.message && (
          <Anim index={1}>
            <Banner title="Audience created" tone="success">
              {actionData.message}
            </Banner>
          </Anim>
        )}

        <Anim index={1}>
          <AutoCreateCard
            adAccounts={adAccounts}
            busy={nav.state !== "idle"}
          />
        </Anim>
        {showCreator && (
          <Anim index={2}>
            <div className="ap-card-hover">
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
                        className="ap-card-hover"
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
            </div>
          </Anim>
        )}

        <Layout>
          <Layout.Section>
            <Anim index={3}>
              <div className="ap-card-hover">
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
                    columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
                    headings={["Name", "Type", "Ad account", "Status", "Size", "Created", ""]}
                    rows={rows}
                  />
                )}
                  </BlockStack>
                </Card>
              </div>
            </Anim>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function AutoCreateCard({
  adAccounts,
  busy,
}: {
  adAccounts: Array<{ id: string; adAccountName: string; adAccountId: string }>;
  busy: boolean;
}) {
  const [objective, setObjective] = useState("TRAFFIC");
  const [name, setName] = useState("");
  const [adAccountDbId, setAdAccountDbId] = useState(adAccounts[0]?.id ?? "");
  const submit = useSubmit();

  const autoCreate = () => {
    const data = new FormData();
    data.set("intent", "auto_create");
    data.set("adAccountDbId", adAccountDbId);
    data.set("objective", objective);
    data.set("name", name);
    submit(data, { method: "post" });
  };

  return (
    <div className="ap-card-hover">
      <Card>
        <Box padding="500">
        <BlockStack gap="400">
          <InlineStack gap="200" blockAlign="center">
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "12px",
                background: "linear-gradient(135deg, #5c6ac4, #8b5cf6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "20px",
              }}
            >
              🎯
            </div>
            <BlockStack gap="050">
              <Text as="h2" variant="headingLg">
                Auto-create Audience
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Smart targeting in one click — no manual setup needed
              </Text>
            </BlockStack>
          </InlineStack>
        <Grid columns={{ xs: 1, md: 3 }}>
          <Grid.Cell>
            <Select
              label="Campaign objective"
              options={[
                { label: "Traffic", value: "TRAFFIC" },
                { label: "Engagement", value: "ENGAGEMENT" },
                { label: "Sales", value: "SALES" },
                { label: "Awareness", value: "AWARENESS" },
              ]}
              value={objective}
              onChange={setObjective}
            />
          </Grid.Cell>
          <Grid.Cell>
            <Select
              label="Ad account"
              options={adAccounts.map((a) => ({
                label: `${a.adAccountName} (${a.adAccountId})`,
                value: a.id,
              }))}
              value={adAccountDbId}
              onChange={setAdAccountDbId}
            />
          </Grid.Cell>
          <Grid.Cell>
            <TextField
              label="Audience name (optional)"
              value={name}
              onChange={setName}
              placeholder="Auto-generated if empty"
              autoComplete="off"
            />
          </Grid.Cell>
        </Grid>
        <InlineStack gap="200" blockAlign="center">
          <Button
            variant="primary"
            size="large"
            disabled={busy || !adAccountDbId}
            loading={busy}
            onClick={autoCreate}
          >
            ✨ Generate & Create ($1.20)
          </Button>
          <Text as="p" variant="bodySm" tone="subdued">
            Analyzes your Page, picks the best interests, age & demographics —
            then creates it on Meta.
          </Text>
        </InlineStack>
        </BlockStack>
        </Box>
      </Card>
    </div>
  );
}
