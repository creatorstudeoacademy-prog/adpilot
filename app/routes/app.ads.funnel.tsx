import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
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
import { createFullFunnel } from "../lib/meta-ads.server";
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import { logActivity } from "../lib/activity.server";
import {
  AUDIENCE_FEE,
  FUNNEL_AUDIENCE_COUNT,
  FUNNEL_AUDIENCE_FEE,
  FUNNEL_BUDGET_SPLIT,
  FUNNEL_CAMPAIGN_FEE,
  FUNNEL_TOTAL_FEE,
  OBJECTIVE_FEES,
  OBJECTIVE_FEE_LABELS,
} from "../lib/pricing";

import { COUNTRIES as COUNTRY_OPTIONS } from "../lib/countries";
import { currencySymbol, formatMoney } from "../lib/format";

const CTA_OPTIONS = [
  { label: "Shop Now", value: "SHOP_NOW" },
  { label: "Learn More", value: "LEARN_MORE" },
  { label: "Sign Up", value: "SIGN_UP" },
  { label: "Download", value: "DOWNLOAD" },
  { label: "Get Offer", value: "GET_OFFER" },
];

const STAGE_META = [
  {
    stage: "TOF",
    title: "Top of Funnel — Awareness",
    description: "Broad reach to cold audiences. Introduces your brand.",
    objective: "AWARENESS",
    share: FUNNEL_BUDGET_SPLIT.TOF,
    audienceName: "Saved audience — broad (country + age)",
  },
  {
    stage: "MOF",
    title: "Middle of Funnel — Engagement",
    description: "Retargets video viewers & page engagers with social proof.",
    objective: "ENGAGEMENT",
    share: FUNNEL_BUDGET_SPLIT.MOF,
    audienceName: "Custom audience — video viewers & engagers",
  },
  {
    stage: "BOF",
    title: "Bottom of Funnel — Sales",
    description: "Retargets website visitors with a strong offer.",
    objective: "SALES",
    share: FUNNEL_BUDGET_SPLIT.BOF,
    audienceName: "Custom audience — website visitors",
  },
] as const;

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

  const intent = String(form.get("intent") ?? "create");

  // Retry failed funnel stages without re-charging (the fee was already paid).
  if (intent === "retry_failed") {
    const funnelId = String(form.get("funnelId") ?? "");
    const funnel = await prisma.funnelGroup.findFirst({
      where: { id: funnelId, shop },
      include: { campaigns: true },
    });
    if (!funnel || (funnel.status !== "partial" && funnel.status !== "failed")) {
      return json({ ok: false, error: "Nothing to retry for this funnel." });
    }
    const failed = funnel.campaigns.filter((c) => c.status === "failed");
    if (failed.length === 0) {
      return json({ ok: false, error: "All stages already succeeded." });
    }
    const adAccount = await prisma.adAccount.findFirst({
      where: { id: funnel.adAccountId, shop },
    });
    if (!adAccount) return json({ ok: false, error: "Ad account not found." });
    const page = await prisma.socialAccount.findFirst({
      where: { shop, platform: "facebook" },
    });
    if (!page) return json({ ok: false, error: "Connect a Facebook Page first." });

    // All stages share the same creative — reuse it from a failed campaign.
    const ref = failed[0];
    if (!ref.headline || !ref.primaryText || !ref.imageUrl) {
      return json({ ok: false, error: "Missing creative on failed stages — rebuild the funnel." });
    }
    const onlyStages = failed.map((c) => c.funnelStage) as Array<"TOF" | "MOF" | "BOF">;

    try {
      const { createFullFunnel } = await import("../lib/meta-ads.server");
      const result = await createFullFunnel({
        adAccountId: adAccount.adAccountId,
        accessToken: adAccount.accessToken,
        pageId: page.pageId,
        funnelName: funnel.name,
        totalDailyBudget: funnel.totalDailyBudget,
        country: funnel.country,
        ageMin: funnel.ageMin,
        ageMax: funnel.ageMax,
        headline: ref.headline,
        primaryText: ref.primaryText,
        description: ref.description ?? "",
        imageUrl: ref.imageUrl,
        destinationUrl: funnel.destinationUrl ?? ref.destinationUrl ?? "",
        cta: ref.cta ?? "SHOP_NOW",
        onlyStages,
        ...(funnel.catalogProductSetId ? { catalogProductSetId: funnel.catalogProductSetId } : {}),
      });
      let succeeded = 0;
      for (const stage of result.stages) {
        if (!onlyStages.includes(stage.stage)) continue; // not retried
        const campaign = funnel.campaigns.find((c) => c.funnelStage === stage.stage);
        if (!campaign) continue;
        if (stage.campaignId) {
          succeeded++;
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: {
              status: "active",
              metaCampaignId: stage.campaignId,
              metaAdSetId: stage.adSetId ? JSON.stringify([stage.adSetId]) : null,
              metaAdId: stage.adId ? JSON.stringify([stage.adId]) : null,
              error: stage.audienceFallback
                ? "Audience creation fell back to standard targeting."
                : null,
            },
          });
        } else {
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: "failed", error: stage.error },
          });
        }
      }
      const totalActive = funnel.campaigns.filter(
        (c) => c.status === "active" || result.stages.find((s) => s.stage === c.funnelStage)?.campaignId,
      ).length;
      const funnelStatus = totalActive === 3 ? "active" : totalActive > 0 ? "partial" : "failed";
      await prisma.funnelGroup.update({
        where: { id: funnel.id },
        data: {
          status: funnelStatus,
          error:
            totalActive < 3
              ? `Retry partial: ${result.stages
                  .filter((s) => s.error)
                  .map((s) => `${s.stage}: ${s.error}`)
                  .join(" | ")}`
              : null,
        },
      });
      logActivity({
        shop,
        action: "ad_publish",
        detail: `funnel retry:${funnel.id} stages:${succeeded}/${failed.length} (no re-charge)`,
        feeCharged: 0,
      });
      return json({
        ok: true,
        message: `Retried ${failed.length} stage(s): ${succeeded} succeeded.`,
      });
    } catch (e) {
      return json({
        ok: false,
        error: e instanceof Error ? e.message : "Retry failed.",
      });
    }
  }

  const adAccountDbId = String(form.get("adAccountDbId") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const productUrl = String(form.get("productUrl") ?? "").trim();
  const totalBudget = parseFloat(String(form.get("totalBudget") ?? "0"));
  const country = String(form.get("country") ?? "US");
  const ageMin = parseInt(String(form.get("ageMin") ?? "25"), 10) || 25;
  const ageMax = parseInt(String(form.get("ageMax") ?? "64"), 10) || 64;
  const headline = String(form.get("headline") ?? "").trim();
  const primaryText = String(form.get("primaryText") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const imageUrl = String(form.get("imageUrl") ?? "").trim();
  const destinationUrl = String(form.get("destinationUrl") ?? "").trim() || productUrl;
  const cta = String(form.get("cta") ?? "SHOP_NOW");

  if (!name) return json({ ok: false, error: "Give your funnel a name." });
  if (!productUrl) return json({ ok: false, error: "Enter the product / website URL." });
  const budgetAcct = adAccountDbId
    ? await prisma.adAccount.findFirst({ where: { id: adAccountDbId, shop }, select: { currency: true } })
    : null;
  const budgetCur = budgetAcct?.currency ?? "USD";
  if (!totalBudget || totalBudget < 3)
    return json({ ok: false, error: `Total daily budget must be at least ${currencySymbol(budgetCur)}3 (split across 3 stages).` });
  if (!headline || !primaryText || !imageUrl)
    return json({ ok: false, error: "Creative needs a headline, primary text and an image URL." });
  if (ageMin < 13 || ageMax > 65 || ageMin >= ageMax)
    return json({ ok: false, error: "Age range must be valid (13–65, min < max)." });

  const fee = FUNNEL_TOTAL_FEE; // $7.50 campaigns + $3.00 audiences

  const adAccount = await prisma.adAccount.findFirst({
    where: { id: adAccountDbId, shop },
  });
  if (!adAccount) return json({ ok: false, error: "Ad account not found." });

  const page = await prisma.socialAccount.findFirst({
    where: { shop, platform: "facebook" },
  });
  if (!page) return json({ ok: false, error: "Connect a Facebook Page first." });

  const wallet = await getWallet(shop);
  // Free shops (owner's own stores) skip the balance check.
  if (!isFreeShop(shop) && wallet.balance < fee) {
    return redirect("/app/wallet?need=" + fee.toFixed(2));
  }

  // Create the funnel group + 3 draft campaigns.
  const catalogProductSetId = String(form.get("productSetId") ?? "").trim();
  const funnel = await prisma.funnelGroup.create({
    data: {
      shop,
      adAccountId: adAccount.id,
      name,
      totalDailyBudget: totalBudget,
      country,
      ageMin,
      ageMax,
      destinationUrl,
      publishFee: fee,
      status: "draft",
      ...(catalogProductSetId ? { catalogProductSetId } : {}),
    },
  });

  const stageBudgets = {
    TOF: Math.round(totalBudget * FUNNEL_BUDGET_SPLIT.TOF * 100) / 100,
    MOF: Math.round(totalBudget * FUNNEL_BUDGET_SPLIT.MOF * 100) / 100,
    BOF: Math.round(totalBudget * FUNNEL_BUDGET_SPLIT.BOF * 100) / 100,
  };

  const campaigns = await Promise.all(
    (["TOF", "MOF", "BOF"] as const).map((stage) =>
      prisma.campaign.create({
        data: {
          shop,
          adAccountId: adAccount.id,
          funnelGroupId: funnel.id,
          funnelStage: stage,
          name: `${name} - ${stage}`,
          objective: stage === "TOF" ? "AWARENESS" : stage === "MOF" ? "ENGAGEMENT" : "SALES",
          status: "draft",
          dailyBudget: stageBudgets[stage],
          headline,
          primaryText,
          description,
          imageUrl,
          destinationUrl,
          cta,
          publishFee: OBJECTIVE_FEES[stage === "TOF" ? "AWARENESS" : stage === "MOF" ? "ENGAGEMENT" : "SALES"],
        },
      }),
    ),
  );

  // Deduct the full funnel fee BEFORE calling Meta (non-refundable once created).
  await deduct(
    shop,
    fee,
    `Full funnel publish fee: ${name} (3 campaigns $7.50 + 3 audiences $3.00)`,
    funnel.id,
  );

  try {
    const result = await createFullFunnel({
      adAccountId: adAccount.adAccountId,
      accessToken: adAccount.accessToken,
      pageId: page.pageId,
      funnelName: name,
      totalDailyBudget: totalBudget,
      country,
      ageMin,
      ageMax,
      headline,
      primaryText,
      description,
      imageUrl,
      destinationUrl,
      cta,
      ...(catalogProductSetId ? { catalogProductSetId } : {}),
    });

    let succeeded = 0;
    for (const stage of result.stages) {
      const campaign = campaigns.find((c) => c.funnelStage === stage.stage)!;
      if (stage.campaignId) {
        succeeded++;
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            status: "active",
            metaCampaignId: stage.campaignId,
            metaAdSetId: stage.adSetId ? JSON.stringify([stage.adSetId]) : null,
            metaAdId: stage.adId ? JSON.stringify([stage.adId]) : null,
            error: stage.audienceFallback
              ? "Audience creation fell back to standard targeting."
              : null,
          },
        });
      } else {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: "failed", error: stage.error },
        });
      }
    }

    const funnelStatus =
      succeeded === 3 ? "active" : succeeded > 0 ? "partial" : "failed";
    await prisma.funnelGroup.update({
      where: { id: funnel.id },
      data: {
        status: funnelStatus,
        error:
          succeeded === 0
            ? result.stages.map((s) => `${s.stage}: ${s.error}`).join(" | ")
            : succeeded < 3
              ? `Partial: ${result.stages
                  .filter((s) => s.error)
                  .map((s) => `${s.stage}: ${s.error}`)
                  .join(" | ")}`
              : null,
      },
    });

    if (succeeded === 0) {
      // Nothing was created — refund the fee.
      await refund(shop, fee, `Refund: full funnel publish failed for ${name}`, funnel.id);
      return json({
        ok: false,
        error: "Meta publish failed for all 3 stages. Your wallet was refunded.",
      });
    }

    logActivity({
      shop,
      action: "ad_publish",
      detail: `funnel:${funnel.id} stages:${succeeded}/3 fee:${fee.toFixed(2)}`,
      feeCharged: isFreeShop(shop) ? 0 : fee,
    });

    return redirect(`/app/ads/campaigns?funnel=${funnel.id}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Meta publish failed.";
    await refund(shop, fee, `Refund: full funnel publish failed for ${name}`, funnel.id);
    await prisma.funnelGroup.update({
      where: { id: funnel.id },
      data: { status: "failed", error: message },
    });
    return json({ ok: false, error: message });
  }
};

export default function FullFunnel() {
  const { adAccounts, walletBalance, pages } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  const [step, setStep] = useState(1);
  const [quickMode, setQuickMode] = useState(false);
  const [quickGoal, setQuickGoal] = useState("SALES");
  const [quickBudget, setQuickBudget] = useState("30");
  const [quickBusy, setQuickBusy] = useState(false);
  const [adAccountDbId, setAdAccountDbId] = useState(adAccounts[0]?.id ?? "");
  const acctCurrency = adAccounts.find((a) => a.id === adAccountDbId)?.currency ?? "USD";
  const acctSymbol = currencySymbol(acctCurrency);
  const [searchParams] = useSearchParams();
  const [name, setName] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [totalBudget, setTotalBudget] = useState(searchParams.get("budget") ?? "30");
  const [country, setCountry] = useState(searchParams.get("country") ?? "US");
  const [ageMin, setAgeMin] = useState(searchParams.get("ageMin") ?? "25");
  const [ageMax, setAgeMax] = useState(searchParams.get("ageMax") ?? "64");
  const [headline, setHeadline] = useState("");
  const [primaryText, setPrimaryText] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  // Catalog connection: optional product set -> BOF stage becomes a dynamic catalog ad.
  const [productSets, setProductSets] = useState<Array<{ id: string; name: string; product_count?: number }>>([]);
  const [productSetId, setProductSetId] = useState("");
  const [setsLoading, setSetsLoading] = useState(false);
  const loadProductSets = async () => {
    if (productSets.length > 0 || setsLoading) return;
    setSetsLoading(true);
    try {
      const res = await fetch("/api/ads/catalog-products?catalogId=active&type=sets");
      const data = (await res.json()) as {
        ok: boolean;
        sets?: Array<{ id: string; name: string; product_count?: number }>;
      };
      if (data.ok) {
        setProductSets(data.sets ?? []);
        if ((data.sets ?? []).length === 1) setProductSetId(data.sets![0].id);
      }
    } catch {
      // optional feature; stays empty
    } finally {
      setSetsLoading(false);
    }
  };
  const [cta, setCta] = useState("SHOP_NOW");
  const [aiFilling, setAiFilling] = useState(false);
  const [aiFillError, setAiFillError] = useState("");
  const [suggesting, setSuggesting] = useState<string | null>(null);

  const suggestField = async (
    field: "headline" | "primaryText" | "description",
    setter: (v: string) => void,
  ) => {
    if (suggesting || !name.trim()) return;
    setSuggesting(field);
    setAiFillError("");
    try {
      const res = await fetch("/api/ai/suggest-field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, topic: name.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Suggestion failed.");
      setter(data.suggestion);
    } catch (e) {
      setAiFillError(e instanceof Error ? e.message : "Suggestion failed.");
    } finally {
      setSuggesting(null);
    }
  };

  const fillWithAI = async () => {
    if (aiFilling || !name.trim()) return;
    setAiFilling(true);
    setAiFillError("");
    try {
      const res = await fetch("/api/ai/generate-creative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: name.trim(),
          objective: "SALES",
          tone: "Professional",
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "AI fill failed.");
      if (data.headline) setHeadline(data.headline);
      if (data.primaryText) setPrimaryText(data.primaryText);
      if (data.description) setDescription(data.description);
    } catch (e) {
      setAiFillError(e instanceof Error ? e.message : "AI fill failed.");
    } finally {
      setAiFilling(false);
    }
  };


  const total = parseFloat(totalBudget) || 0;
  const split = {
    TOF: Math.round(total * FUNNEL_BUDGET_SPLIT.TOF * 100) / 100,
    MOF: Math.round(total * FUNNEL_BUDGET_SPLIT.MOF * 100) / 100,
    BOF: Math.round(total * FUNNEL_BUDGET_SPLIT.BOF * 100) / 100,
  };
  const insufficient = FUNNEL_TOTAL_FEE > walletBalance;

  const publish = () => {
    const fd = new FormData();
    fd.append("adAccountDbId", adAccountDbId);
    fd.append("name", name);
    fd.append("productUrl", productUrl);
    fd.append("totalBudget", totalBudget);
    fd.append("country", country);
    fd.append("ageMin", ageMin);
    fd.append("ageMax", ageMax);
    fd.append("headline", headline);
    fd.append("primaryText", primaryText);
    fd.append("description", description);
    fd.append("imageUrl", imageUrl);
    fd.append("destinationUrl", destinationUrl || productUrl);
    fd.append("cta", cta);
    if (productSetId) fd.append("productSetId", productSetId);
    submit(fd, { method: "post" });
  };

  const canNext1 = name.trim() && productUrl.trim() && total >= 3;
  const canNext3 =
    headline.trim() && primaryText.trim() && imageUrl.trim();

  /** Quick mode: 3 selections → AI creative → publish full funnel. */
  const quickCreate = async () => {
    if (quickBusy || !name.trim() || !productUrl.trim()) return;
    setQuickBusy(true);
    setAiFillError("");
    try {
      // 1. Generate creative.
      const res = await fetch("/api/ai/generate-creative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: name.trim(),
          objective: quickGoal,
          tone: "Professional",
          source: "funnel",
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Creative generation failed.");

      // 2. Publish with generated creative + quick selections.
      const fd = new FormData();
      fd.append("adAccountDbId", adAccountDbId);
      fd.append("name", name);
      fd.append("productUrl", productUrl);
      fd.append("totalBudget", quickBudget);
      fd.append("country", country);
      fd.append("ageMin", ageMin);
      fd.append("ageMax", ageMax);
      fd.append("headline", data.headline ?? "");
      fd.append("primaryText", data.primaryText ?? "");
      fd.append("description", data.description ?? "");
      fd.append("imageUrl", imageUrl);
      fd.append("destinationUrl", productUrl);
      fd.append("cta", cta);
      if (productSetId) fd.append("productSetId", productSetId);
      submit(fd, { method: "post" });
    } catch (e) {
      setAiFillError(e instanceof Error ? e.message : "Quick create failed.");
    } finally {
      setQuickBusy(false);
    }
  };

  return (
    <Page
      title="Full-Funnel Campaign"
      subtitle="One click — 3 campaigns, 3 audiences, full funnel live"
      backAction={{ content: "Ads", url: "/app/ads" }}
    >
      <BlockStack gap="500">
        {actionData && !actionData.ok && (
          <Banner title="Couldn't publish the funnel" tone="critical">
            {actionData.error}
          </Banner>
        )}
        {pages.length === 0 && (
          <Banner title="No Facebook Page connected" tone="warning">
            Connect a Facebook Page under Accounts — ads need a Page to run from.
          </Banner>
        )}

        <InlineStack gap="200" align="end">
          <Button
            variant={quickMode ? "primary" : undefined}
            onClick={() => setQuickMode((v) => !v)}
          >
            {quickMode ? "✓ Quick mode" : "Quick mode"}
          </Button>
        </InlineStack>

        {quickMode ? (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                ⚡ Quick Funnel — just 3 selections
              </Text>
              {aiFillError && (
                <Banner tone="critical">
                  <p>{aiFillError}</p>
                </Banner>
              )}
              <TextField
                label="1. What is the campaign about?"
                value={name}
                onChange={setName}
                placeholder="e.g. Winter Jacket Launch"
                autoComplete="off"
              />
              <TextField
                label="Product / website URL"
                value={productUrl}
                onChange={setProductUrl}
                placeholder="https://yourstore.com/products/..."
                autoComplete="off"
              />
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  2. Pick your goal
                </Text>
                <InlineStack gap="200">
                  {[
                    { label: "🛒 Sales", value: "SALES" },
                    { label: "👥 Traffic", value: "TRAFFIC" },
                    { label: "❤️ Engagement", value: "ENGAGEMENT" },
                  ].map((g) => (
                    <Button
                      key={g.value}
                      variant={quickGoal === g.value ? "primary" : undefined}
                      onClick={() => setQuickGoal(g.value)}
                    >
                      {g.label}
                    </Button>
                  ))}
                </InlineStack>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  3. Daily budget
                </Text>
                <InlineStack gap="200">
                  {["10", "20", "30", "50"].map((b) => (
                    <Button
                      key={b}
                      variant={quickBudget === b ? "primary" : undefined}
                      onClick={() => setQuickBudget(b)}
                    >
                      {acctSymbol}{b}/day
                    </Button>
                  ))}
                </InlineStack>
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">
                We auto-write your ad creative, create 3 audiences and launch
                all 3 funnel stages. Fee: ${FUNNEL_TOTAL_FEE.toFixed(2)} (no
                extra charge for creative).
              </Text>
              <Button
                variant="primary"
                size="large"
                loading={quickBusy}
                disabled={!name.trim() || !productUrl.trim()}
                onClick={() => void quickCreate()}
              >
                🚀 Create full funnel
              </Button>
            </BlockStack>
          </Card>
        ) : (
          <>
        {/* Stepper */}
        <Card>
          <InlineStack gap="400">
            {["Basics", "Targeting", "Creative", "Review"].map((label, i) => (
              <Text
                key={label}
                as="p"
                variant={step === i + 1 ? "headingSm" : "bodyMd"}
                tone={step === i + 1 ? undefined : "subdued"}
              >
                {i + 1}. {label}
              </Text>
            ))}
          </InlineStack>
        </Card>

        {step === 1 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Funnel basics
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
                label="Funnel name"
                value={name}
                onChange={setName}
                placeholder="e.g. Winter Jacket Launch"
                autoComplete="off"
              />
              <TextField
                label="Product / website URL"
                value={productUrl}
                onChange={setProductUrl}
                placeholder="https://yourstore.com/products/..."
                autoComplete="off"
                helpText="Used as the ad destination and for the website retargeting audience."
              />
              <TextField
                label={`Total daily budget (${acctCurrency})`}
                type="number"
                value={totalBudget}
                onChange={setTotalBudget}
                autoComplete="off"
                helpText="Auto-split across the 3 stages: 50% TOF, 30% MOF, 20% BOF. Ad budgets are billed by Meta directly to your ad account."
              />
              {total >= 3 && (
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="headingSm">
                      Budget split
                    </Text>
                    <InlineStack align="space-between">
                      <Text as="p" tone="subdued">TOF — Awareness (50%)</Text>
                      <Text as="p">{formatMoney(split.TOF, acctCurrency)}/day</Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="p" tone="subdued">MOF — Engagement (30%)</Text>
                      <Text as="p">{formatMoney(split.MOF, acctCurrency)}/day</Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="p" tone="subdued">BOF — Sales (20%)</Text>
                      <Text as="p">{formatMoney(split.BOF, acctCurrency)}/day</Text>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}
              <InlineStack align="end">
                <Button variant="primary" disabled={!canNext1} onClick={() => setStep(2)}>
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
                Targeting
              </Text>
              <Text as="p" tone="subdued">
                Applies to all 3 stages. TOF stays broad; MOF and BOF retarget
                the audiences created below.
              </Text>
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
              <Card>
                <BlockStack gap="200">
                  <Text as="p" variant="headingSm">
                    Audiences that will be created
                  </Text>
                  {STAGE_META.map((s) => (
                    <InlineStack key={s.stage} align="space-between">
                      <Text as="p" tone="subdued">
                        {s.stage} — {s.audienceName}
                      </Text>
                      <Text as="p" tone="subdued">
                        ${AUDIENCE_FEE.toFixed(2)}
                      </Text>
                    </InlineStack>
                  ))}
                  <Text as="p" variant="bodySm" tone="subdued">
                    If audience creation fails (e.g. missing permissions), that
                    stage falls back to standard targeting automatically.
                  </Text>
                </BlockStack>
              </Card>
              <InlineStack align="space-between">
                <Button onClick={() => setStep(1)}>Back</Button>
                <Button variant="primary" onClick={() => setStep(3)}>
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
                Creative
              </Text>
              <Text as="p" tone="subdued">
                One creative set is used across all 3 stages (Meta optimizes
                delivery per stage).
              </Text>
              <Card>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      🛍️ Catalog for BOF (optional)
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Connect a product set to turn the BOF (Sales) stage into a
                    dynamic catalog ad — Meta shows each person the product
                    they're most likely to buy. Better performance for stores
                    with a synced catalog.
                  </Text>
                  <Select
                    label="Product set"
                    options={[
                      { label: setsLoading ? "Loading…" : "No catalog (standard BOF ad)", value: "" },
                      ...productSets.map((ps) => ({
                        label: `${ps.name}${ps.product_count != null ? ` (${ps.product_count} products)` : ""}`,
                        value: ps.id,
                      })),
                    ]}
                    value={productSetId}
                    onChange={setProductSetId}
                    onFocus={() => void loadProductSets()}
                  />
                  {!productSetId && !setsLoading && productSets.length === 0 && (
                    <div>
                      <Button size="slim" variant="plain" onClick={() => void loadProductSets()}>
                        Load product sets
                      </Button>
                    </div>
                  )}
                </BlockStack>
              </Card>
              <InlineStack gap="200" align="start">
                <Button
                  loading={aiFilling}
                  disabled={!name.trim()}
                  onClick={fillWithAI}
                >
                  ✨ Fill with AI ($0.20)
                </Button>
              </InlineStack>
              {aiFillError && (
                <Banner tone="critical">
                  <p>{aiFillError}</p>
                </Banner>
              )}
              <TextField
                label="Headline"
                value={headline}
                onChange={setHeadline}
                autoComplete="off"
                placeholder="e.g. Winter Sale — Up to 40% Off"
                connectedRight={
                  <Button
                    loading={suggesting === "headline"}
                    disabled={!name.trim()}
                    onClick={() => void suggestField("headline", setHeadline)}
                  >
                    ✨ Suggest
                  </Button>
                }
              />
              <TextField
                label="Primary text"
                value={primaryText}
                onChange={setPrimaryText}
                multiline={3}
                autoComplete="off"
                placeholder="e.g. Stay warm in style..."
                connectedRight={
                  <Button
                    loading={suggesting === "primaryText"}
                    disabled={!name.trim()}
                    onClick={() => void suggestField("primaryText", setPrimaryText)}
                  >
                    ✨ Suggest
                  </Button>
                }
              />
              <TextField
                label="Description (optional)"
                value={description}
                onChange={setDescription}
                autoComplete="off"
                connectedRight={
                  <Button
                    loading={suggesting === "description"}
                    disabled={!name.trim()}
                    onClick={() => void suggestField("description", setDescription)}
                  >
                    ✨ Suggest
                  </Button>
                }
              />
              <TextField
                label="Image / video URL"
                value={imageUrl}
                onChange={setImageUrl}
                autoComplete="off"
                placeholder="https://..."
                helpText="Direct link to a JPG/PNG image or MP4 video — or upload below."
              />
              <InlineStack gap="200" align="start" blockAlign="center">
                <Button
                  onClick={() =>
                    document.getElementById("funnel-media-upload")?.click()
                  }
                >
                  Upload image/video
                </Button>
                <input
                  id="funnel-media-upload"
                  type="file"
                  accept="image/jpeg,image/png,image/gif,video/mp4,video/quicktime"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const formData = new FormData();
                    formData.append("file", f);
                    try {
                      const res = await fetch("/api/upload-media", {
                        method: "POST",
                        body: formData,
                      });
                      const data = await res.json();
                      if (data.ok && data.url) setImageUrl(data.url);
                    } catch {
                      // ignore
                    }
                    e.target.value = "";
                  }}
                />
                {imageUrl && (
                  <Text as="span" variant="bodySm" tone="success">
                    ✓ Media set
                  </Text>
                )}
              </InlineStack>
              <TextField
                label="Destination URL (optional)"
                value={destinationUrl}
                onChange={setDestinationUrl}
                autoComplete="off"
                placeholder="Defaults to the product URL"
              />
              <Select
                label="Call to action"
                options={CTA_OPTIONS}
                value={cta}
                onChange={setCta}
              />
              <InlineStack align="space-between">
                <Button onClick={() => setStep(2)}>Back</Button>
                <Button variant="primary" disabled={!canNext3} onClick={() => setStep(4)}>
                  Review funnel
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <BlockStack gap="500">
              <Text as="h2" variant="headingMd">
                Review & publish
              </Text>

              <BlockStack gap="200">
                <Text as="p" variant="headingSm">
                  Campaigns (3)
                </Text>
                {STAGE_META.map((s) => (
                  <Card key={s.stage}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="p" variant="headingSm">
                          {s.title}
                        </Text>
                        <Text as="p">
                          ${(total * s.share).toFixed(2)}/day
                        </Text>
                      </InlineStack>
                      <Text as="p" tone="subdued">
                        {s.description}
                      </Text>
                      <InlineStack align="space-between">
                        <Text as="p" tone="subdued">
                          Objective: {OBJECTIVE_FEE_LABELS[s.objective]} · Audience: {s.audienceName}
                        </Text>
                        <Text as="p" tone="subdued">
                          Fee: ${OBJECTIVE_FEES[s.objective].toFixed(2)}
                        </Text>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>

              <BlockStack gap="200">
                <Text as="p" variant="headingSm">
                  Publishing fee breakdown
                </Text>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">
                    Campaigns (3) — TOF $2.00 + MOF $2.50 + BOF $3.00
                  </Text>
                  <Text as="p">${FUNNEL_CAMPAIGN_FEE.toFixed(2)}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">
                    Audiences ({FUNNEL_AUDIENCE_COUNT}) — ${AUDIENCE_FEE.toFixed(2)} each
                  </Text>
                  <Text as="p">${FUNNEL_AUDIENCE_FEE.toFixed(2)}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" variant="headingSm">
                    Total
                  </Text>
                  <Text as="p" variant="headingSm">
                    ${FUNNEL_TOTAL_FEE.toFixed(2)}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="p" tone="subdued">
                    Wallet balance after
                  </Text>
                  <Text as="p">
                    ${(walletBalance - FUNNEL_TOTAL_FEE).toFixed(2)}
                  </Text>
                </InlineStack>
                {insufficient && (
                  <Banner tone="warning">
                    Insufficient wallet balance. You need $
                    {FUNNEL_TOTAL_FEE.toFixed(2)} — top up your wallet first.
                  </Banner>
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  Daily ad budgets are billed separately by Meta to your ad
                  account.
                </Text>
                <Text as="p" variant="bodySm" tone="critical">
                  This action is irreversible. The ${FUNNEL_TOTAL_FEE.toFixed(2)}{" "}
                  publishing fee will be deducted from your wallet immediately.
                  It is refunded automatically if Meta rejects the publish.
                </Text>
              </BlockStack>

              <InlineStack align="space-between">
                <Button onClick={() => setStep(3)}>Back</Button>
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={publish}
                >
                  {insufficient
                    ? "Top up & publish"
                    : `Publish full funnel ($${FUNNEL_TOTAL_FEE.toFixed(2)})`}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
        </>
        )}
      </BlockStack>

      <Layout.Section>
        <div style={{ height: 24 }} />
      </Layout.Section>
    </Page>
  );
}
