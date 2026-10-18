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
import { OBJECTIVES } from "../lib/meta-ads";
import { publishFullCampaign } from "../lib/meta-ads.server";
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import { logActivity } from "../lib/activity.server";
import {
  OBJECTIVE_FEES,
  OBJECTIVE_FEE_LABELS,
  calculatePublishFee,
} from "../lib/pricing";
import { NavButton } from "../components/NavButton";
import { COUNTRIES } from "../lib/countries";

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

  // Edit mode: prefill the form from an existing draft campaign.
  const editId = new URL(request.url).searchParams.get("edit");
  let draft: Record<string, unknown> | null = null;
  if (editId) {
    const d = await prisma.campaign.findFirst({
      where: { id: editId, shop, status: "draft" },
    });
    if (d) {
      draft = {
        id: d.id,
        adAccountDbId: d.adAccountId,
        objective: d.objective,
        name: d.name,
        dailyBudget: d.dailyBudget,
        startDate: d.startDate ? d.startDate.toISOString().slice(0, 10) : "",
        endDate: d.endDate ? d.endDate.toISOString().slice(0, 10) : "",
        adSetCount: d.adSetCount,
        creative: {
          headline: d.headline ?? "",
          primaryText: d.primaryText ?? "",
          description: d.description ?? "",
          imageUrl: d.imageUrl ?? "",
          destinationUrl: d.destinationUrl ?? "",
          cta: d.cta ?? "SHOP_NOW",
        },
        audienceDbId: d.audienceDbId ?? "",
      };
    }
  }

  return json({
    adAccounts: adAccounts.map((a) => ({
      id: a.id,
      adAccountId: a.adAccountId,
      adAccountName: a.adAccountName,
      currency: a.currency,
      pixelId: a.pixelId,
    })),
    walletBalance: wallet.balance,
    isFreeShop: isFreeShop(shop),
    pages,
    audiences,
    draft,
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

  // Placements: Advantage+ (default, no placement params) or manual.
  const placementMode = String(form.get("placementMode") ?? "advantage");
  let placementIds: string[] = [];
  try {
    const raw = String(form.get("placements") ?? "");
    if (raw) placementIds = JSON.parse(raw) as string[];
  } catch {
    placementIds = [];
  }
  const placementTargeting: Record<string, unknown> = {};
  if (placementMode === "manual" && placementIds.length > 0) {
    const platforms = new Set<string>();
    const fbPos = new Set<string>();
    const igPos = new Set<string>();
    for (const pid of placementIds) {
      if (pid === "fb_feed") {
        platforms.add("facebook");
        fbPos.add("feed");
      } else if (pid === "ig_feed") {
        platforms.add("instagram");
        igPos.add("stream");
      } else if (pid === "reels") {
        platforms.add("facebook");
        platforms.add("instagram");
        fbPos.add("video_feeds");
        igPos.add("reels");
      } else if (pid === "stories") {
        platforms.add("facebook");
        platforms.add("instagram");
        fbPos.add("story");
        igPos.add("story");
      }
    }
    placementTargeting.publisher_platforms = [...platforms];
    if (fbPos.size > 0) placementTargeting.facebook_positions = [...fbPos];
    if (igPos.size > 0) placementTargeting.instagram_positions = [...igPos];
  }

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
            ...placementTargeting,
          }
        : {
            custom_audiences: [{ id: audience.metaAudienceId }],
            geo_locations: { countries: [country] },
            age_min: ageMin,
            age_max: ageMax,
            ...placementTargeting,
          };
  } else {
    adSetTargeting = {
      geo_locations: { countries: [country] },
      age_min: ageMin,
      age_max: ageMax,
      ...placementTargeting,
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
  // Free shops (owner's own stores) skip the balance check.
  const wallet = await getWallet(shop);
  if (!isFreeShop(shop) && wallet.balance < fee.total) {
    return redirect("/app/wallet?need=" + fee.total.toFixed(2));
  }

  // Edit mode: update the existing draft instead of creating a duplicate.
  const editId = String(form.get("editId") ?? "");
  const firstCreative = creatives[0];
  let campaign: { id: string };
  if (editId) {
    const existing = await prisma.campaign.findFirst({
      where: { id: editId, shop, status: "draft" },
    });
    if (!existing) return json({ ok: false, error: "Draft not found." });
    campaign = await prisma.campaign.update({
      where: { id: existing.id },
      data: {
        adAccountId: adAccount.id,
        name,
        objective,
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
      },
    });
  } else {
    // Create draft record first.
    campaign = await prisma.campaign.create({
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
  }

  // Deduct the publish fee from the wallet BEFORE calling Meta.
  await deduct(
    shop,
    fee.total,
    `Ad publish fee (${fee.objectiveLabel}): ${name} — ${adSetCount} ad set(s), ${creatives.length} creative(s)`,
    campaign.id,
  );

  try {
    const catalogProductSetId =
      objective === "CATALOG_SALES" ? String(form.get("productSetId") ?? "").trim() : "";
    if (objective === "CATALOG_SALES" && !catalogProductSetId) {
      return json({ ok: false, error: "Choose a catalog product set for Catalog Sales ads." });
    }
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
      ...(catalogProductSetId ? { catalogProductSetId } : {}),
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
    logActivity({
      shop,
      action: "ad_publish",
      detail: `campaign:${campaign.id} objective:${objective} fee:${fee.total.toFixed(2)}`,
      feeCharged: isFreeShop(shop) ? 0 : fee.total,
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
  const { adAccounts, walletBalance, isFreeShop, pages, audiences, draft } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const d = (draft ?? {}) as Record<string, any>;
  const dCreative = (d.creative ?? {}) as Record<string, string>;

  const [step, setStep] = useState(1);
  const [objective, setObjective] = useState<string>((d.objective as string) ?? "TRAFFIC");
  // Catalog sales: product set picker (from the active Meta catalog)
  const [productSets, setProductSets] = useState<Array<{ id: string; name: string; product_count?: number }>>([]);
  const [productSetId, setProductSetId] = useState<string>("");
  const [setsLoading, setSetsLoading] = useState(false);
  const [setsError, setSetsError] = useState<string | null>(null);
  const loadProductSets = async () => {
    if (productSets.length > 0 || setsLoading) return;
    setSetsLoading(true);
    setSetsError(null);
    try {
      const res = await fetch("/api/ads/catalog-products?catalogId=active&type=sets");
      const data = (await res.json()) as {
        ok: boolean;
        message?: string;
        sets?: Array<{ id: string; name: string; product_count?: number }>;
      };
      if (!data.ok) throw new Error(data.message ?? "Could not load product sets.");
      setProductSets(data.sets ?? []);
      if ((data.sets ?? []).length === 1) setProductSetId(data.sets![0].id);
    } catch (e) {
      setSetsError(e instanceof Error ? e.message : "Could not load product sets.");
    } finally {
      setSetsLoading(false);
    }
  };
  const [adAccountDbId, setAdAccountDbId] = useState<string>(
    (d.adAccountDbId as string) ?? adAccounts[0]?.id ?? "",
  );
  const [name, setName] = useState<string>((d.name as string) ?? "");
  const [searchParams] = useSearchParams();
  const beginnerMode = searchParams.get("beginner") === "1";
  const [dailyBudget, setDailyBudget] = useState<string>(
    d.dailyBudget != null ? String(d.dailyBudget) : (searchParams.get("budget") ?? "10"),
  );
  const [startDate, setStartDate] = useState<string>((d.startDate as string) ?? "");
  const [endDate, setEndDate] = useState<string>((d.endDate as string) ?? "");
  const [adSetCount, setAdSetCount] = useState<number>(Number(d.adSetCount) || 1);
  const [creatives, setCreatives] = useState<CreativeForm[]>([
    d.creative
      ? {
          headline: dCreative.headline ?? "",
          primaryText: dCreative.primaryText ?? "",
          description: dCreative.description ?? "",
          imageUrl: dCreative.imageUrl ?? "",
          destinationUrl: dCreative.destinationUrl ?? "",
          cta: dCreative.cta ?? "SHOP_NOW",
        }
      : {
          ...EMPTY_CREATIVE,
          headline: searchParams.get("product") ?? "",
          primaryText: searchParams.get("product") ?? "",
        },
  ]);
  const [targetingMode, setTargetingMode] = useState<"new" | "saved">(
    d.audienceDbId ? "saved" : "new",
  );
  const [audienceDbId, setAudienceDbId] = useState(
    (d.audienceDbId as string) || audiences[0]?.id || "",
  );
  const [country, setCountry] = useState(searchParams.get("country") ?? "US");
  const [ageMin, setAgeMin] = useState(searchParams.get("ageMin") ?? "18");
  const [ageMax, setAgeMax] = useState(searchParams.get("ageMax") ?? "65");
  // Placements: "advantage" (default, Meta automatic) or manual selection.
  const [placementMode, setPlacementMode] = useState<"advantage" | "manual">("advantage");
  const [manualPlacements, setManualPlacements] = useState<string[]>([]);
  const togglePlacement = (id: string) =>
    setManualPlacements((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  const [pixelTesting, setPixelTesting] = useState(false);
  const [pixelTestMsg, setPixelTestMsg] = useState("");
  const [pixelTestOk, setPixelTestOk] = useState(false);

  const sendPixelTest = async () => {
    setPixelTesting(true);
    setPixelTestMsg("");
    try {
      const res = await fetch("/api/pixel/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adAccountDbId }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
      setPixelTestOk(!!data.ok);
      setPixelTestMsg(data.ok ? data.message ?? "Sent." : data.error ?? "Failed.");
    } catch {
      setPixelTestOk(false);
      setPixelTestMsg("Could not reach the server.");
    } finally {
      setPixelTesting(false);
    }
  };
  const [aiFilling, setAiFilling] = useState<number | null>(null);
  const [aiFillError, setAiFillError] = useState("");
  const [uploading, setUploading] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [suggestingUrl, setSuggestingUrl] = useState<number | null>(null);
  const [urlSuggestion, setUrlSuggestion] = useState("");

  const suggestUrl = async (index: number) => {
    if (suggestingUrl !== null || !name.trim()) return;
    setSuggestingUrl(index);
    setUrlSuggestion("");
    try {
      const res = await fetch("/api/ai/suggest-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: name.trim(), objective }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Suggestion failed.");
      updateCreative(index, { destinationUrl: data.url });
      if (data.reason) setUrlSuggestion(`${data.label}: ${data.reason}`);
    } catch (e) {
      setUrlSuggestion(e instanceof Error ? e.message : "Suggestion failed.");
    } finally {
      setSuggestingUrl(null);
    }
  };

  const uploadMedia = async (index: number, file: File) => {
    setUploading(index);
    setUploadError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload-media", {
        method: "POST",
        body: formData,
      });
      const text = await res.text();
      let data: { ok: boolean; url?: string; type?: string; error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Upload failed (server error: ${text.slice(0, 100)})`);
      }
      if (!data.ok) throw new Error(data.error || "Upload failed.");
      if (data.url) {
        updateCreative(index, { imageUrl: data.url });
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  const fillCreativeWithAI = async (index: number) => {
    if (aiFilling !== null || !name.trim()) return;
    setAiFilling(index);
    setAiFillError("");
    try {
      const res = await fetch("/api/ai/generate-creative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: name.trim(), objective, tone: "Professional" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "AI fill failed.");
      setCreatives((prev) =>
        prev.map((c, i) =>
          i === index
            ? {
                ...c,
                headline: data.headline || c.headline,
                primaryText: data.primaryText || c.primaryText,
                description: data.description || c.description,
              }
            : c,
        ),
      );
    } catch (e) {
      setAiFillError(e instanceof Error ? e.message : "AI fill failed.");
    } finally {
      setAiFilling(null);
    }
  };

  const budgetNum = parseFloat(dailyBudget) || 0;
  const fee = calculatePublishFee(objective, adSetCount, creatives.length);
  const insufficient = !isFreeShop && fee.total > walletBalance;

  const updateCreative = (index: number, patch: Partial<CreativeForm>) => {
    setCreatives((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const addCreative = () => {
    if (creatives.length < 5) setCreatives((prev) => [...prev, { ...EMPTY_CREATIVE }]);
  };

  const removeCreative = (index: number) => {
    if (creatives.length > 1) setCreatives((prev) => prev.filter((_, i) => i !== index));
  };

  const isCatalogSales = objective === "CATALOG_SALES";
  const creativesValid =
    creatives.every((c) =>
      isCatalogSales
        ? c.headline.trim() && c.primaryText.trim()
        : c.headline.trim() && c.primaryText.trim() && c.imageUrl.trim() && c.destinationUrl.trim(),
    ) && (!isCatalogSales || !!productSetId);

  const publish = () => {
    const data = new FormData();
    if (d.id) data.set("editId", String(d.id));
    data.set("adAccountDbId", adAccountDbId);
    data.set("objective", objective);
    data.set("name", name);
    data.set("dailyBudget", dailyBudget);
    data.set("startDate", startDate);
    data.set("endDate", endDate);
    data.set("adSetCount", String(adSetCount));
    data.set("creatives", JSON.stringify(creatives));
    if (objective === "CATALOG_SALES" && productSetId) data.set("productSetId", productSetId);
    data.set("targetingMode", targetingMode);
    data.set("placementMode", placementMode);
    if (placementMode === "manual" && manualPlacements.length > 0) {
      data.set("placements", JSON.stringify(manualPlacements));
    }
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
              {(() => {
                const selected = adAccounts.find((a) => a.id === adAccountDbId);
                return selected?.pixelId ? (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="success">
                      ✓ Meta Pixel {selected.pixelId} connected — conversions will be tracked
                    </Text>
                    <Button
                      size="slim"
                      variant="plain"
                      disabled={busy}
                      loading={pixelTesting}
                      onClick={sendPixelTest}
                    >
                      Send test event
                    </Button>
                    {pixelTestMsg && (
                      <Text as="p" variant="bodySm" tone={pixelTestOk ? "success" : "critical"}>
                        {pixelTestMsg}
                      </Text>
                    )}
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No Meta Pixel connected.{" "}
                    <a href="/app/accounts">Add one in Accounts</a> for conversion tracking.
                  </Text>
                );
              })()}
              <TextField
                label="Campaign name"
                value={name}
                onChange={setName}
                placeholder="Summer Sale 2026"
                autoComplete="off"
              />
              <TextField
                label={`Daily budget (${adAccounts.find((a) => a.id === adAccountDbId)?.currency ?? "USD"})`}
                type="number"
                min="1"
                value={dailyBudget}
                onChange={setDailyBudget}
                autoComplete="off"
                helpText={`Enter in ${adAccounts.find((a) => a.id === adAccountDbId)?.currency ?? "USD"} — Meta charges the ad account in its own currency. Wallet balance: $${walletBalance.toFixed(2)}`}
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
                    <NavButton plain url="/app/ads/audiences">
                      Create one in Audience Manager
                    </NavButton>
                  </Banner>
                )}
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 4, sm: 2, md: 2, lg: 4, xl: 4 }}>
                    <Select
                      label="Country"
                      options={COUNTRIES}
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
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Placements
                  </Text>
                  <ChoiceList
                    title="Placement mode"
                    titleHidden
                    choices={[
                      {
                        label: "Advantage+ placements (recommended)",
                        value: "advantage",
                        helpText: "Meta automatically shows your ad where it performs best.",
                      },
                      { label: "Manual placements", value: "manual" },
                    ]}
                    selected={[placementMode]}
                    onChange={(v) => setPlacementMode(v[0] as "advantage" | "manual")}
                  />
                  {placementMode === "manual" && (
                    <ChoiceList
                      title="Choose placements"
                      allowMultiple
                      choices={[
                        { label: "Facebook Feed", value: "fb_feed" },
                        { label: "Instagram Feed", value: "ig_feed" },
                        { label: "Facebook & Instagram Reels", value: "reels" },
                        { label: "Stories (Facebook & Instagram)", value: "stories" },
                      ]}
                      selected={manualPlacements}
                      onChange={setManualPlacements}
                    />
                  )}
                </BlockStack>
              </BlockStack>
              <InlineStack align="space-between">
                <Button onClick={() => setStep(1)}>Back</Button>
                <BlockStack gap="100">
                  <Button
                    variant="primary"
                    onClick={() => setStep(3)}
                    disabled={!name.trim() || budgetNum <= 0}
                  >
                    Continue
                  </Button>
                  {(!name.trim() || budgetNum <= 0) && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Enter a campaign name and a daily budget above to continue.
                    </Text>
                  )}
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {step === 3 && (
          <BlockStack gap="400">
            {isCatalogSales && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    🛍️ Catalog product set
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Meta will dynamically show the right product from this set
                    to each person. Image and link come from your catalog —
                    headline and text below are used as the ad template.
                  </Text>
                  {setsError && <Banner tone="critical">{setsError}</Banner>}
                  <Select
                    label="Product set"
                    options={[
                      { label: setsLoading ? "Loading…" : "Choose a product set…", value: "" },
                      ...productSets.map((ps) => ({
                        label: `${ps.name}${ps.product_count != null ? ` (${ps.product_count} products)` : ""}`,
                        value: ps.id,
                      })),
                    ]}
                    value={productSetId}
                    onChange={setProductSetId}
                    onFocus={() => void loadProductSets()}
                  />
                  {!productSetId && !setsLoading && (
                    <div>
                      <Button size="slim" variant="plain" onClick={() => void loadProductSets()}>
                        Load product sets
                      </Button>
                    </div>
                  )}
                </BlockStack>
              </Card>
            )}
            {aiFillError && <Banner tone="critical">{aiFillError}</Banner>}
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
                    <InlineStack gap="200">
                      <Button
                        size="slim"
                        disabled={aiFilling === index || !name.trim()}
                        loading={aiFilling === index}
                        onClick={() => fillCreativeWithAI(index)}
                      >
                        ✨ Fill with AI ($0.20)
                      </Button>
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
                    helpText="A direct link to your ad image (JPG/PNG) — or upload below."
                  />
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      size="slim"
                      disabled={uploading === index}
                      loading={uploading === index}
                      onClick={() =>
                        document
                          .getElementById(`media-upload-${index}`)
                          ?.click()
                      }
                    >
                      📤 Upload image/video
                    </Button>
                    <input
                      id={`media-upload-${index}`}
                      type="file"
                      accept="image/*,video/*"
                      style={{ display: "none" }}
                      disabled={uploading === index}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadMedia(index, f);
                        e.target.value = "";
                      }}
                    />
                    {creative.imageUrl && (
                      <Text as="span" variant="bodySm" tone="success">
                        ✓ Media set
                      </Text>
                    )}
                  </InlineStack>
                  {creative.imageUrl && (
                    <div style={{ marginTop: "8px" }}>
                      {/\.(mp4|mov)(\?|$)/i.test(creative.imageUrl) ? (
                        <video
                          src={creative.imageUrl}
                          controls
                          style={{ maxWidth: "200px", maxHeight: "150px", borderRadius: "8px" }}
                        />
                      ) : (
                        <img
                          src={creative.imageUrl}
                          alt="Ad creative preview"
                          style={{ maxWidth: "200px", maxHeight: "150px", borderRadius: "8px", objectFit: "cover" }}
                        />
                      )}
                    </div>
                  )}
                  {uploadError && uploading === null && (
                    <Banner tone="critical">{uploadError}</Banner>
                  )}
                  <TextField
                    label="Destination URL"
                    value={creative.destinationUrl}
                    onChange={(v) => updateCreative(index, { destinationUrl: v })}
                    placeholder="https://yourstore.com/products/..."
                    autoComplete="off"
                    helpText="Where the ad sends people — AI can suggest the best page, or paste manually."
                  />
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      size="slim"
                      disabled={suggestingUrl === index || !name.trim()}
                      loading={suggestingUrl === index}
                      onClick={() => suggestUrl(index)}
                    >
                      🤖 Suggest best URL
                    </Button>
                    {urlSuggestion && suggestingUrl === null && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {urlSuggestion}
                      </Text>
                    )}
                  </InlineStack>
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
              <BlockStack gap="100">
                <Button
                  variant="primary"
                  onClick={() => setStep(4)}
                  disabled={!creativesValid}
                >
                  Review
                </Button>
                {!creativesValid && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Fill in headline, primary text, image URL and destination
                    URL for every creative to continue.
                  </Text>
                )}
              </BlockStack>
            </InlineStack>
          </BlockStack>
        )}

        {step === 4 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Review & publish
              </Text>
              {creatives.some((c) => /\.webp(\?|$)/i.test(c.imageUrl)) && (
                <Banner tone="critical">
                  One or more creatives use WebP images, which Meta ads do not support.
                  Go back to Step 3 and re-upload as JPG/PNG (images) or MP4 (videos).
                </Banner>
              )}
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
                  deducted from your wallet immediately. It is refunded
                  automatically if Meta rejects the publish.
                </Text>
              </BlockStack>

              <InlineStack align="space-between">
                <Button onClick={() => setStep(3)}>Back</Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={creatives.some((c) => /\.webp(\?|$)/i.test(c.imageUrl))}
                  onClick={publish}
                >
                  {insufficient
                    ? "Top up & publish"
                    : isFreeShop
                      ? "Publish campaign (Free)"
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
