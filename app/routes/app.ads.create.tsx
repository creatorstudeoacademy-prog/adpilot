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

  return json({
    adAccounts: adAccounts.map((a) => ({
      id: a.id,
      adAccountId: a.adAccountId,
      adAccountName: a.adAccountName,
      currency: a.currency,
    })),
    walletBalance: wallet.balance,
    pages,
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
  const headline = String(form.get("headline") ?? "").trim();
  const primaryText = String(form.get("primaryText") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const imageUrl = String(form.get("imageUrl") ?? "").trim();
  const destinationUrl = String(form.get("destinationUrl") ?? "").trim();
  const cta = String(form.get("cta") ?? "");

  if (!name || !dailyBudget || dailyBudget <= 0 || !headline || !primaryText || !imageUrl || !destinationUrl) {
    return json({ ok: false, error: "Fill in all required fields." });
  }

  const adAccount = await prisma.adAccount.findFirst({
    where: { id: adAccountDbId, shop },
  });
  if (!adAccount) return json({ ok: false, error: "Ad account not found." });

  const page = await prisma.socialAccount.findFirst({
    where: { shop, platform: "facebook" },
  });
  if (!page) return json({ ok: false, error: "Connect a Facebook Page first." });

  // Wallet check happens before touching Meta.
  const wallet = await getWallet(shop);
  if (wallet.balance < dailyBudget) {
    return redirect("/app/wallet?need=" + dailyBudget.toFixed(2));
  }

  // Create draft record first.
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
      headline,
      primaryText,
      description,
      imageUrl,
      destinationUrl,
      cta,
    },
  });

  // Deduct from wallet BEFORE calling Meta.
  await deduct(shop, dailyBudget, `Ad spend: ${name}`, campaign.id);

  try {
    const result = await publishFullCampaign({
      adAccountId: adAccount.adAccountId,
      accessToken: adAccount.accessToken,
      pageId: page.pageId,
      name,
      objective,
      dailyBudget,
      startDate: startDateStr ? new Date(startDateStr) : null,
      endDate: endDateStr ? new Date(endDateStr) : null,
      headline,
      primaryText,
      description,
      imageUrl,
      destinationUrl,
      cta,
    });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "active",
        metaCampaignId: result.campaignId,
        metaAdSetId: result.adSetId,
        metaAdId: result.adId,
      },
    });

    return redirect("/app/ads/campaigns?published=1");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Meta publish failed.";
    // Refund the wallet since Meta failed.
    await refund(shop, dailyBudget, `Refund: Meta publish failed for ${name}`, campaign.id);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "failed", error: message },
    });
    return json({ ok: false, error: message });
  }
};

export default function CreateCampaign() {
  const { adAccounts, walletBalance, pages } = useLoaderData<typeof loader>();
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
  const [headline, setHeadline] = useState("");
  const [primaryText, setPrimaryText] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [cta, setCta] = useState("SHOP_NOW");

  const budgetNum = parseFloat(dailyBudget) || 0;
  const insufficient = budgetNum > walletBalance;

  const publish = () => {
    const data = new FormData();
    data.set("adAccountDbId", adAccountDbId);
    data.set("objective", objective);
    data.set("name", name);
    data.set("dailyBudget", dailyBudget);
    data.set("startDate", startDate);
    data.set("endDate", endDate);
    data.set("headline", headline);
    data.set("primaryText", primaryText);
    data.set("description", description);
    data.set("imageUrl", imageUrl);
    data.set("destinationUrl", destinationUrl);
    data.set("cta", cta);
    submit(data, { method: "post" });
  };

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
            Wallet balance (${walletBalance.toFixed(2)}) is below the daily
            budget (${budgetNum.toFixed(2)}). You will be asked to top up
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
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Ad creative
              </Text>
              <TextField
                label="Headline"
                value={headline}
                onChange={setHeadline}
                placeholder="50% Off Summer Collection"
                autoComplete="off"
              />
              <TextField
                label="Primary text"
                value={primaryText}
                onChange={setPrimaryText}
                multiline={4}
                placeholder="Tell people what makes your offer great..."
                autoComplete="off"
              />
              <TextField
                label="Description (optional)"
                value={description}
                onChange={setDescription}
                autoComplete="off"
              />
              <TextField
                label="Image URL"
                value={imageUrl}
                onChange={setImageUrl}
                placeholder="https://..."
                autoComplete="off"
                helpText="A direct link to your ad image (JPG/PNG)."
              />
              <TextField
                label="Destination URL"
                value={destinationUrl}
                onChange={setDestinationUrl}
                placeholder="https://yourstore.com/products/..."
                autoComplete="off"
              />
              <Select
                label="Call-to-action button"
                options={CTA_OPTIONS}
                value={cta}
                onChange={setCta}
              />
              <InlineStack align="space-between">
                <Button onClick={() => setStep(2)}>Back</Button>
                <Button
                  variant="primary"
                  onClick={() => setStep(4)}
                  disabled={
                    !headline.trim() ||
                    !primaryText.trim() ||
                    !imageUrl.trim() ||
                    !destinationUrl.trim()
                  }
                >
                  Review
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
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
                  <Text as="p" tone="subdued">Headline</Text>
                  <Text as="p">{headline}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">Wallet balance after</Text>
                  <Text as="p">${(walletBalance - budgetNum).toFixed(2)}</Text>
                </InlineStack>
              </BlockStack>
              <InlineStack align="space-between">
                <Button onClick={() => setStep(3)}>Back</Button>
                <Button variant="primary" loading={busy} onClick={publish}>
                  {insufficient ? "Top up & publish" : "Publish campaign"}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
