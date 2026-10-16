import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  ChoiceList,
  DatePicker,
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
import { OBJECTIVES, publishFullCampaign } from "../lib/meta-ads.server";
import { deduct, getWallet, refund } from "../lib/wallet.server";
import {
  OBJECTIVE_FEES,
  OBJECTIVE_FEE_LABELS,
  calculatePublishFee,
} from "../lib/pricing";

const CTA_OPTIONS = [
  { label: "Shop Now", value: "SHOP_NOW" },
  { label: "Learn More", value: "LEARN_MORE" },
  { label: "Sign Up", value: "SIGN_UP" },
  { label: "Download", value: "DOWNLOAD" },
  { label: "Get Offer", value: "GET_OFFER" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [adAccounts, wallet, pages] = await Promise.all([
    prisma.adAccount.findMany({ where: { shop } }),
    getWallet(shop),
    prisma.socialAccount.findMany({
      where: { shop, platform: "facebook" },
      select: { pageId: true, pageName: true },
    }),
  ]);

  if (adAccounts.length === 0) return redirect("/app/ads/connect");

  const audiences = await prisma.audience.findMany({
    where: { shop, status: "active", metaAudienceId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      type: true,
      subtype: true,
      metaAudienceId: true,
      approxCount: true,
    },
  });

  return json({
    adAccounts: adAccounts.map((a) => ({
      id: a.id,
      adAccountId: a.adAccountId,
      adAccountName: a.adAccountName,
      currency: a.currency,
    })),
    walletBalance: wallet.balance,
    pages,
    audiences,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  const adAccountDbId = String(form.get("adAccountDbId") ?? "");
  const objective = String(form.get("objective") ?? "TRAFFIC");
  const name = String(form.get("name") ?? "").trim();
  const dailyBudget = parseFloat(String(form.get("dailyBudget") ?? "0"));
  const startDateStr = String(form.get("startDate") ?? "");
  const endDateStr = String(form.get("endDate") ?? "");
  const adSetCount = Math.min(5, Math.max(1, parseInt(String(form.get("adSetCount") ?? "1"), 10) || 1));

  // Audience / targeting selection.
  const targetingMode = String(form.get("targetingMode") ?? "new"); // new | saved
  const audienceDbId = String(form.get("audienceDbId") ?? "");
  const country = String(form.get("country") ?? "US");
  const ageMin = parseInt(String(form.get("ageMin") ?? "18"), 10) || 18;
  const ageMax = parseInt(String(form.get("ageMax") ?? "65"), 10) || 65;

  let adSetTargeting: Record<string, unknown> | undefined;
  let audienceName: string | null = null;
  if (targetingMode === "saved" && audienceDbId) {
    const audience = await prisma.audience.findFirst({
      where: { id: audienceDbId, shop, status: "active" },
    });
    if (!audience?.metaAudienceId) {
      return json({ ok: false, error: "Selected audience is not available." });
    }
    audienceName = audience.name;
    adSetTargeting =
      audience.subtype === "SAVED"
        ? {
            saved_audience_id: audience.metaAudienceId,
            geo_locations: { countries: [country] },
            age_min: ageMin,
            age_max: ageMax,
          }
        : {
            custom_audiences: [{ id: audience.metaAudienceId }],
            geo_locations: { countries: [country] },
            age_min: ageMin,
            age_max: ageMax,
          };
  } else {
    adSetTargeting = {
      geo_locations: { countries: [country] },
      age_min: ageMin,
      age_max: ageMax,
    };
  }

  let creatives: Array<{
    headline: string;
    primaryText: string;
    description: string;
    imageUrl: string;
    destinationUrl: string;
    cta: string;
  }> = [];
  try {
    creatives = JSON.parse(String(form.get("creatives") ?? "[]"));
  } catch {
    creatives = [];
  }
  creatives = creatives
    .slice(0, 5)
    .map((c) => ({
      headline: String(c.headline ?? "").trim(),
      primaryText: String(c.primaryText ?? "").trim(),
      description: String(c.description ?? "").trim(),
      imageUrl: String(c.imageUrl ?? "").trim(),
      destinationUrl: String(c.destinationUrl ?? "").trim(),
      cta: String(c.cta ?? "SHOP_NOW"),
    }));

  if (!name || !dailyBudget || dailyBudget <= 0) {
    return json({ ok: false, error: "Fill in the campaign name and a valid daily budget." });
  }
  if (creatives.length === 0) {
    return json({ ok: false, error: "Add at least one creative." });
  }
  const badCreative = creatives.find(
    (c) => !c.headline || !c.primaryText || !c.imageUrl || !c.destinationUrl,
  );
  if (badCreative) {
    return json({ ok: false, error: "Every creative needs a headline, primary text, image URL and destination URL." });
  }

  const fee = calculatePublishFee(objective, adSetCount, creatives.length);

  const adAccount = await prisma.adAccount.findFirst({
    where: { id: adAccountDbId, shop },
  });
  if (!adAccount) return json({ ok: false, error: "Ad account not found." });

  const page = await prisma.socialAccount.findFirst({
    where: { shop, platform: "facebook" },
  });
  if (!page) return json({ ok: false, error: "Connect a Facebook Page first." });

  // Wallet check happens before touching Meta.
  // Fee = base by objective + $1.50 per extra ad set + $1 per extra creative.
  // The ad budget itself is billed by Meta directly to the user's ad account.
  const wallet = await getWallet(shop);
  if (wallet.balance < fee.total) {
    return redirect("/app/wallet?need=" + fee.total.toFixed(2));
  }

  // Create draft record first.
  const firstCreative = creatives[0];
  const campaign = await prisma.campaign.create({
    data: {
      shop,
      adAccountId: adAccount.id,
      name,
      objective,
      status: "draft",
      dailyBudget,
      startDate: startDateStr ? new Date(startDateStr) : null,
      endDate: endDateStr ? new Date(endDateStr) : null,
      headline: firstCreative.headline,
      primaryText: firstCreative.primaryText,
      description: firstCreative.description,
      imageUrl: firstCreative.imageUrl,
      destinationUrl: firstCreative.destinationUrl,
      cta: firstCreative.cta,
      adSetCount,
      creativeCount: creatives.length,
      publishFee: fee.total,
      audienceDbId: targetingMode === "saved" && audienceDbId ? audienceDbId : null,
      audienceName,
    },
  });

  // Deduct the publish fee from the wallet BEFORE calling Meta.
  await deduct(
    shop,
    fee.total,
    `Ad publish fee (${fee.objectiveLabel}): ${name} — ${adSetCount} ad set(s), ${creatives.length} creative(s)`,
    campaign.id,
  );

  try {
    const result = await publishFullCampaign({
      adAccountId: adAccount.adAccountId,
      accessToken: adAccount.accessToken,
      pageId: page.pageId,
      name,
      objective,
      adSets: Array.from({ length: adSetCount }, (_, i) => ({
        name: adSetCount > 1 ? `${name} - Ad Set ${i + 1}` : `${name} - Ad Set`,
        dailyBudget,
        startDate: startDateStr ? new Date(startDateStr) : null,
        endDate: endDateStr ? new Date(endDateStr) : null,
      })),
      creatives,
      adSetTargeting,
    });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "active",
        metaCampaignId: result.campaignId,
        metaAdSetId: JSON.stringify(result.adSetIds),
        metaAdId: JSON.stringify(result.adIds),
      },
    });

    return redirect("/app/ads/campaigns?published=1");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Meta publish failed.";
    // Refund the wallet since Meta failed.
    await refund(shop, fee.total, `Refund: Meta publish failed for ${name}`, campaign.id);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "failed", error: message },
    });
    return json({ ok: false, error: message });
  }
};

interface CreativeForm {
  headline: string;
  primaryText: string;
  description: string;
  imageUrl: string;
  destinationUrl: string;
  cta: string;
}

const EMPTY_CREATIVE: CreativeForm = {
  headline: "",
  primaryText: "",
  description: "",
  imageUrl: "",
  destinationUrl: "",
  cta: "SHOP_NOW",
};

export default function CreateCampaign() {
  const { adAccounts, walletBalance, pages, audiences } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  const [step, setStep] = useState(1);
  const [objective, setObjective] = useState("TRAFFIC");
  const [adAccountDbId, setAdAccountDbId] = useState(adAccounts[0]?.id ?? "");
  const [name, setName] = useState("");
  const [dailyBudget, setDailyBudget] = useState("10");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [adSetCount, setAdSetCount] = useState(1);
  const [creatives, setCreatives] = useState<CreativeForm[]>([{ ...EMPTY_CREATIVE }]);
  const [targetingMode, setTargetingMode] = useState<"new" | "saved">("new");
  const [audienceDbId, setAudienceDbId] = useState(audiences[0]?.id ?? "");
  const [country, setCountry] = useState("US");
  const [ageMin, setAgeMin] = useState("18");
  const [ageMax, setAgeMax] = useState("65");

  const budgetNum = parseFloat(dailyBudget) || 0;
  const fee = calculatePublishFee(objective, adSetCount, creatives.length);
  const insufficient = fee.total > walletBalance;

  const updateCreative = (index: number, patch: Partial<CreativeForm>) => {
    setCreatives((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const addCreative = () => {
    if (creatives.length < 5) setCreatives((prev) => [...prev, { ...EMPTY_CREATIVE }]);
  };

  const removeCreative = (index: number) => {
    if (creatives.length > 1) setCreatives((prev) => prev.filter((_, i) => i !== index));
  };

  const creativesValid = creatives.every(
    (c) => c.headline.trim() && c.primaryText.trim() && c.imageUrl.trim() && c.destinationUrl.trim(),
  );

  const publish = () => {
    const data = new FormData();
    data.set("adAccountDbId", adAccountDbId);
    data.set("objective", objective);
    data.set("name", name);
    data.set("dailyBudget", dailyBudget);
    data.set("startDate", startDate);
    data.set("endDate", endDate);
    data.set("adSetCount", String(adSetCount));
    data.set("creatives", JSON.stringify(creatives));
    data.set("targetingMode", targetingMode);
    data.set("audienceDbId", audienceDbId);
    data.set("country", country);
    data.set("ageMin", ageMin);
    data.set("ageMax", ageMax);
    submit(data, { method: "post" });
  };

  const selectedAudience = audiences.find((a) => a.id === audienceDbId);

  return (
    <Page
      title="Create campaign"
      subtitle={`Step ${step} of 4`}
      backAction={{ url: "/app/ads" }}
    >
      <BlockStack gap="500">
        {actionData && "error" in actionData && actionData.error && (
          <Banner tone="critical">{String(actionData.error)}</Banner>
        )}
        {insufficient && step === 4 && (
          <Banner tone="warning">
            Wallet balance (${walletBalance.toFixed(2)}) is below the $
            {fee.total.toFixed(2)} publish fee. You will be asked to top up
            before publishing.
          </Banner>
        )}

        {step === 1 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Choose your objective
              </Text>
              <Grid>
                {OBJECTIVES.map((o) => (
                  <Grid.Cell key={o.id} columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
                    <div
                      onClick={() => setObjective(o.id)}
                      style={{
                        border:
                          objective === o.id
                            ? "2px solid #008060"
                            : "1px solid #d2d5d9",
                        borderRadius: 8,
                        padding: 16,
                        cursor: "pointer",
                        background: objective === o.id ? "#f6fff9" : "#fff",
                      }}
                    >
                      <BlockStack gap="200">
                        <Text as="p" variant="headingSm">
                          {o.name}
                        </Text>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {o.description}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Publish fee: ${OBJECTIVE_FEES[o.id].toFixed(2)} per ad
                        </Text>
                      </BlockStack>
                    </div>
                  </Grid.Cell>
                ))}
              </Grid>
              <InlineStack align="end">
                <Button variant="primary" onClick={() => setStep(2)}>
                  Continue
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Campaign details
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
              <TextField
                label="Campaign name"
                value={name}
                onChange={setName}
                placeholder="Summer Sale 2026"
                autoComplete="off"
              />
              <TextField
                label="Daily budget (USD)"
                type="number"
                min="1"
                value={dailyBudget}
                onChange={setDailyBudget}
                autoComplete="off"
                helpText={`Wallet balance: $${walletBalance.toFixed(2)}`}
              />
              <Grid>
                <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
                  <TextField
                    label="Start date (optional)"
                    type="date"
                    value={startDate}
                    onChange={setStartDate}
                    autoComplete="off"
                  />
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
                  <TextField
                    label="End date (optional)"
                    type="date"
                    value={endDate}
                    onChange={setEndDate}
                    autoComplete="off"
                  />
                </Grid.Cell>
              </Grid>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  Number of ad sets
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Button
                    disabled={adSetCount <= 1}
                    onClick={() => setAdSetCount((c) => Math.max(1, c - 1))}
                  >
                    −
                  </Button>
                  <Text as="p" variant="headingMd">
                    {adSetCount}
                  </Text>
                  <Button
                    disabled={adSetCount >= 5}
                    onClick={() => setAdSetCount((c) => Math.min(5, c + 1))}
                  >
                    +
                  </Button>
                  <Text as="p" variant="bodySm" tone="subdued">
                    +$1.50 per extra ad set
                  </Text>
                </InlineStack>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">
                  Audience
                </Text>
                <ChoiceList
                  title="Targeting"
                  choices={[
                    { label: "New targeting — country & age", value: "new" },
                    {
                      label: `Saved audience${audiences.length === 0 ? " (none yet)" : ""}`,
                      value: "saved",
                    },
                  ]}
                  selected={[targetingMode]}
                  onChange={(v) => setTargetingMode(v[0] as "new" | "saved")}
                />
                {targetingMode === "saved" && audiences.length > 0 && (
                  <Select
                    label="Saved audience"
                    options={audiences.map((a) => ({
                      label: `${a.name} (${a.type}${a.approxCount != null ? ` · ~${a.approxCount.toLocaleString()}` : ""})`,
                      value: a.id,
                    }))}
                    value={audienceDbId}
                    onChange={setAudienceDbId}
                    helpText="No extra fee — the fee was charged when the audience was created."
                  />
                )}
                {targetingMode === "saved" && audiences.length === 0 && (
                  <Banner tone="info">
                    No saved audiences yet.{" "}
                    <Button plain url="/app/ads/audiences">
                      Create one in Audience Manager
                    </Button>
                  </Banner>
                )}
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 4, sm: 2, md: 2, lg: 4, xl: 4 }}>
                    <Select
                      label="Country"
                      options={[
                        { label: "United States", value: "US" },
                        { label: "United Kingdom", value: "GB" },
                        { label: "Canada", value: "CA" },
                        { label: "Australia", value: "AU" },
                        { label: "Germany", value: "DE" },
                        { label: "France", value: "FR" },
                        { label: "India", value: "IN" },
                        { label: "Bangladesh", value: "BD" },
                      ]}
                      value={country}
                      onChange={setCountry}
                    />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 4, sm: 2, md: 2, lg: 4, xl: 4 }}>
                    <TextField
                      label="Min age"
                      type="number"
                      value={ageMin}
                      onChange={setAgeMin}
                      autoComplete="off"
                    />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 4, sm: 2, md: 2, lg: 4, xl: 4 }}>
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
              <InlineStack align="space-between">
                <Button onClick={() => setStep(1)}>Back</Button>
                <Button
                  variant="primary"
                  onClick={() => setStep(3)}
                  disabled={!name.trim() || budgetNum <= 0}
                >
                  Continue
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {step === 3 && (
          <BlockStack gap="400">
            {creatives.map((creative, index) => (
              <Card key={index}>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Creative {index + 1}
                      {index > 0 && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {" "}(+$1.00)
                        </Text>
                      )}
                    </Text>
                    {creatives.length > 1 && (
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => removeCreative(index)}
                      >
                        Remove
                      </Button>
                    )}
                  </InlineStack>
                  <TextField
                    label="Headline"
                    value={creative.headline}
                    onChange={(v) => updateCreative(index, { headline: v })}
                    placeholder="50% Off Summer Collection"
                    autoComplete="off"
                  />
                  <TextField
                    label="Primary text"
                    value={creative.primaryText}
                    onChange={(v) => updateCreative(index, { primaryText: v })}
                    multiline={4}
                    placeholder="Tell people what makes your offer great..."
                    autoComplete="off"
                  />
                  <TextField
                    label="Description (optional)"
                    value={creative.description}
                    onChange={(v) => updateCreative(index, { description: v })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Image URL"
                    value={creative.imageUrl}
                    onChange={(v) => updateCreative(index, { imageUrl: v })}
                    placeholder="https://..."
                    autoComplete="off"
                    helpText="A direct link to your ad image (JPG/PNG)."
                  />
                  <TextField
                    label="Destination URL"
                    value={creative.destinationUrl}
                    onChange={(v) => updateCreative(index, { destinationUrl: v })}
                    placeholder="https://yourstore.com/products/..."
                    autoComplete="off"
                  />
                  <Select
                    label="Call-to-action button"
                    options={CTA_OPTIONS}
                    value={creative.cta}
                    onChange={(v) => updateCreative(index, { cta: v })}
                  />
                </BlockStack>
              </Card>
            ))}

            {creatives.length < 5 && (
              <Button onClick={addCreative}>
                + Add another creative (+$1.00)
              </Button>
            )}

            <InlineStack align="space-between">
              <Button onClick={() => setStep(2)}>Back</Button>
              <Button
                variant="primary"
                onClick={() => setStep(4)}
                disabled={!creativesValid}
              >
                Review
              </Button>
            </InlineStack>
          </BlockStack>
        )}

        {step === 4 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Review & publish
              </Text>
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Objective</Text>
                  <Text as="p">{OBJECTIVES.find((o) => o.id === objective)?.name}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Campaign</Text>
                  <Text as="p">{name}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Daily budget</Text>
                  <Text as="p">${budgetNum.toFixed(2)}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Ad sets</Text>
                  <Text as="p">{adSetCount}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Creatives</Text>
                  <Text as="p">{creatives.length}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Audience</Text>
                  <Text as="p">
                    {targetingMode === "saved" && selectedAudience
                      ? `${selectedAudience.name} (${selectedAudience.type})`
                      : `New targeting — ${country}, age ${ageMin}–${ageMax}`}
                  </Text>
                </InlineStack>
              </BlockStack>

              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">
                  Publishing fee breakdown
                </Text>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">
                    Base ({fee.objectiveLabel})
                  </Text>
                  <Text as="p">${fee.base.toFixed(2)}</Text>
                </InlineStack>
                {fee.extraAdSetCount > 0 && (
                  <InlineStack align="space-between">
                    <Text as="p" tone="subdued">
                      Extra ad sets ({fee.extraAdSetCount})
                    </Text>
                    <Text as="p">${fee.extraAdSets.toFixed(2)}</Text>
                  </InlineStack>
                )}
                {fee.extraCreativeCount > 0 && (
                  <InlineStack align="space-between">
                    <Text as="p" tone="subdued">
                      Extra creatives ({fee.extraCreativeCount})
                    </Text>
                    <Text as="p">${fee.extraCreatives.toFixed(2)}</Text>
                  </InlineStack>
                )}
                <InlineStack align="space-between">
                  <Text as="p" variant="headingSm">
                    Total
                  </Text>
                  <Text as="p" variant="headingSm">
                    ${fee.total.toFixed(2)}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Wallet balance after</Text>
                  <Text as="p">${(walletBalance - fee.total).toFixed(2)}</Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  The daily budget is billed separately by Meta to your ad
                  account.
                </Text>
                <Text as="p" variant="bodySm" tone="critical">
                  This action is irreversible. The publishing fee will be
                  deducted from your wallet immediately and cannot be refunded.
                </Text>
              </BlockStack>

              <InlineStack align="space-between">
                <Button onClick={() => setStep(3)}>Back</Button>
                <Button variant="primary" loading={busy} onClick={publish}>
                  {insufficient
                    ? "Top up & publish"
                    : `Publish campaign ($${fee.total.toFixed(2)})`}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
