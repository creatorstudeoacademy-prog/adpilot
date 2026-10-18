import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData, useSubmit, useFetcher, useNavigation, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deleteCampaign, getCampaigns, toggleCampaign } from "../lib/meta-ads.server";
import { Anim, Hero } from "../components/ui";
import { formatMoney } from "../lib/format";
import CampaignAnalysis from "../components/CampaignAnalysis";

// In-memory cache for Meta campaign lists: 5-minute TTL per ad account.
// Avoids hammering the Graph API (rate limits) on every page load.
const CAMPAIGN_CACHE_TTL_MS = 5 * 60 * 1000;
const campaignCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof getCampaigns>> }>();

async function getCampaignsCached(adAccountId: string, accessToken: string, force = false) {
  const key = `${adAccountId}`;
  const hit = campaignCache.get(key);
  if (!force && hit && Date.now() - hit.at < CAMPAIGN_CACHE_TTL_MS) return hit.data;
  const data = await getCampaigns(adAccountId, accessToken);
  campaignCache.set(key, { at: Date.now(), data });
  return data;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";

  const [campaigns, adAccounts] = await Promise.all([
    prisma.campaign.findMany({
      where: { shop },
      include: { adAccount: { select: { adAccountName: true, currency: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.adAccount.findMany({ where: { shop } }),
  ]);

  // Fetch live campaigns from Meta for every connected ad account —
  // includes campaigns created directly in Ads Manager, not just via AdPilot.
  const metaCampaigns: Array<{
    id: string;
    name: string;
    objective: string;
    status: string;
    dailyBudget: number | null;
    adAccountName: string;
    adAccountId: string;
    metaCampaignId: string;
  }> = [];
  const localMetaIds = new Set(
    campaigns.map((c) => c.metaCampaignId).filter(Boolean),
  );
  let metaFetchError: string | null = null;
  let metaFetchAttempted = false;
  await Promise.all(
    adAccounts.map(async (acct) => {
      metaFetchAttempted = true;
      try {
        const list = await getCampaignsCached(acct.adAccountId, acct.accessToken, forceRefresh);
        for (const m of list) {
          // Skip ones already tracked locally (avoid duplicates).
          if (localMetaIds.has(m.id)) continue;
          metaCampaigns.push({
            id: `meta-${m.id}`,
            name: m.name,
            objective: m.objective,
            status: m.status.toLowerCase(),
            dailyBudget: m.daily_budget ? parseFloat(m.daily_budget) / 100 : null,
            adAccountName: acct.adAccountName,
            adAccountId: acct.adAccountId,
            currency: acct.currency,
            metaCampaignId: m.id,
          });
        }
      } catch (e) {
        // Surface the first error so it's diagnosable instead of silent.
        if (!metaFetchError) {
          metaFetchError =
            e instanceof Error ? e.message : "Could not load Meta campaigns.";
        }
      }
    }),
  );

  return json({
    published: new URL(request.url).searchParams.get("published") === "1",
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      objective: c.objective,
      status: c.status,
      dailyBudget: c.dailyBudget,
      adAccountName: c.adAccount.adAccountName,
      currency: c.adAccount.currency,
      createdAt: c.createdAt,
      metaCampaignId: c.metaCampaignId,
      error: c.error,
      funnelGroupId: c.funnelGroupId,
      source: "adpilot" as const,
    })),
    metaCampaigns,
    metaFetchError,
    metaFetchAttempted,
    adAccountCount: adAccounts.length,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "toggle");
  const campaignId = String(form.get("campaignId") ?? "");
  const activate = form.get("activate") === "1";

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shop },
    include: { adAccount: true },
  });
  if (!campaign) {
    return json({ ok: false, error: "Campaign not found." });
  }
  // Toggle needs Meta ID; delete works for drafts too.
  // Retry works for failed campaigns (fee was refunded on failure).
  if (intent !== "delete" && intent !== "retry" && !campaign.metaCampaignId) {
    return json({ ok: false, error: "Campaign not published to Meta yet." });
  }

  // Retry a failed standalone campaign: re-deduct (it was refunded) and re-publish.
  if (intent === "retry") {
    if (campaign.status !== "failed") {
      return json({ ok: false, error: "Only failed campaigns can be retried." });
    }
    if (campaign.funnelGroupId) {
      return json({
        ok: false,
        error: "Funnel campaigns retry from the funnel — use “Retry funnel stages”.",
      });
    }
    if (!campaign.headline || !campaign.primaryText || !campaign.imageUrl) {
      return json({ ok: false, error: "Campaign is missing its creative — please recreate it." });
    }
    const { publishFullCampaign } = await import("../lib/meta-ads.server");
    const { calculatePublishFee } = await import("../lib/pricing");
    const { deduct, getWallet, isFreeShop, refund } = await import("../lib/wallet.server");
    const fee = calculatePublishFee(
      campaign.objective,
      campaign.adSetCount,
      campaign.creativeCount,
    );
    const page = await prisma.socialAccount.findFirst({
      where: { shop, platform: "facebook" },
    });
    if (!page) return json({ ok: false, error: "Connect a Facebook Page first." });
    const wallet = await getWallet(shop);
    if (!isFreeShop(shop) && wallet.balance < fee.total) {
      return json({
        ok: false,
        error: `Insufficient wallet balance — need $${fee.total.toFixed(2)}.`,
        needTopup: true,
      });
    }
    if (!isFreeShop(shop)) {
      await deduct(shop, fee.total, `Ad publish retry: ${campaign.name}`, campaign.id);
    }
    try {
      const result = await publishFullCampaign({
        adAccountId: campaign.adAccount.adAccountId,
        accessToken: campaign.adAccount.accessToken,
        pageId: page.pageId,
        name: campaign.name,
        objective: campaign.objective,
        adSets: Array.from({ length: campaign.adSetCount }, (_, i) => ({
          name: campaign.adSetCount > 1 ? `${campaign.name} - Ad Set ${i + 1}` : `${campaign.name} - Ad Set`,
          dailyBudget: campaign.dailyBudget,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
        })),
        creatives: [
          {
            headline: campaign.headline,
            primaryText: campaign.primaryText,
            description: campaign.description ?? "",
            imageUrl: campaign.imageUrl,
            destinationUrl: campaign.destinationUrl ?? "",
            cta: campaign.cta ?? "SHOP_NOW",
          },
        ],
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          status: "active",
          metaCampaignId: result.campaignId,
          metaAdSetId: JSON.stringify(result.adSetIds),
          metaAdId: JSON.stringify(result.adIds),
          error: null,
        },
      });
      return json({ ok: true, message: "Campaign published." });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Meta publish failed.";
      if (!isFreeShop(shop)) {
        await refund(shop, fee.total, `Refund: retry publish failed for ${campaign.name}`, campaign.id);
      }
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "failed", error: message },
      });
      return json({ ok: false, error: message });
    }
  }

  try {
    if (intent === "delete") {
      // Draft/failed campaigns have no Meta ID — just delete from DB.
      if (campaign.metaCampaignId) {
        try {
          await deleteCampaign(campaign.metaCampaignId, campaign.adAccount.accessToken);
        } catch (e) {
          // Already gone on Meta's side (deleted in Ads Manager) — still
          // remove the local record so the UI doesn't desync.
          const msg = e instanceof Error ? e.message : "";
          if (!/not exist|not found|does not exist|\(code 100\)/i.test(msg)) throw e;
        }
      }
      await prisma.campaign.delete({ where: { id: campaign.id } });
      return json({ ok: true, deleted: true });
    }
    try {
      await toggleCampaign(campaign.metaCampaignId, campaign.adAccount.accessToken, activate);
    } catch (e) {
      // Gone on Meta's side — mark it instead of leaving a stale "active".
      const msg = e instanceof Error ? e.message : "";
      if (/not exist|not found|does not exist|\(code 100\)/i.test(msg)) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: "failed", error: "This campaign no longer exists in Meta Ads Manager." },
        });
        return json({ ok: false, error: "Campaign no longer exists on Meta — marked as failed." });
      }
      throw e;
    }
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: activate ? "active" : "paused" },
    });
    return json({ ok: true });
  } catch (e) {
    return json({
      ok: false,
      error: e instanceof Error ? e.message : "Could not update campaign.",
    });
  }
};

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge tone="success">Active</Badge>;
    case "paused":
      return <Badge tone="attention">Paused</Badge>;
    case "failed":
      return <Badge tone="critical">Failed</Badge>;
    default:
      return <Badge>Draft</Badge>;
  }
}

export default function Campaigns() {
  const {
    published,
    campaigns,
    metaCampaigns,
    metaFetchError,
    metaFetchAttempted,
    adAccountCount,
  } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const submit = useSubmit();
  const funnelRetry = useFetcher();

  const retryStandalone = (id: string) => {
    const data = new FormData();
    data.set("intent", "retry");
    data.set("campaignId", id);
    submit(data, { method: "post" });
  };

  const retryFunnel = (funnelId: string) => {
    const data = new FormData();
    data.set("intent", "retry_failed");
    data.set("funnelId", funnelId);
    funnelRetry.submit(data, { method: "post", action: "/app/ads/funnel" });
  };
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{
    id: string;
    text: string;
    insights?: {
      impressions?: number;
      reach?: number | null;
      clicks?: number;
      spend?: number;
      ctr?: number;
      cpc?: number;
      cpm?: number;
    } | null;
    campaignName?: string;
    currency?: string;
  } | null>(null);

  const analyze = async (id: string, campaignName?: string) => {
    if (analyzing) return;
    setAnalyzing(id);
    setAnalysis(null);
    try {
      const res = await fetch("/api/ai/analyze-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Analysis failed.");
      setAnalysis({ id, text: data.analysis, insights: data.insights ?? null, campaignName, currency: data.currency ?? "USD" });
    } catch (e) {
      setAnalysis({ id, text: `Error: ${e instanceof Error ? e.message : "failed"}` });
    } finally {
      setAnalyzing(null);
    }
  };

  const analyzeMeta = async (id: string, metaCampaignId: string, adAccountId: string, campaignName?: string) => {
    if (analyzing) return;
    setAnalyzing(id);
    setAnalysis(null);
    try {
      const res = await fetch("/api/ai/analyze-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metaCampaignId, adAccountId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Analysis failed.");
      setAnalysis({ id, text: data.analysis, insights: data.insights ?? null, campaignName, currency: data.currency ?? "USD" });
    } catch (e) {
      setAnalysis({ id, text: `Error: ${e instanceof Error ? e.message : "failed"}` });
    } finally {
      setAnalyzing(null);
    }
  };

  const toggle = (id: string, activate: boolean) => {
    const data = new FormData();
    data.set("intent", "toggle");
    data.set("campaignId", id);
    data.set("activate", activate ? "1" : "0");
    submit(data, { method: "post" });
  };

  const remove = (id: string) => {
    const data = new FormData();
    data.set("intent", "delete");
    data.set("campaignId", id);
    submit(data, { method: "post" });
  };

  const rows = campaigns.map((c) => [
    c.name,
    c.objective,
    statusBadge(c.status),
    `${formatMoney(c.dailyBudget, c.currency)}/day`,
    c.adAccountName,
    <InlineStack key={c.id} gap="200">
      {c.status === "active" ? (
        <Button size="slim" disabled={busy} onClick={() => toggle(c.id, false)}>
          Pause
        </Button>
      ) : c.status === "paused" ? (
        <Button size="slim" disabled={busy} onClick={() => toggle(c.id, true)}>
          Resume
        </Button>
      ) : (
        <Text as="span" variant="bodySm" tone="subdued">
          —
        </Text>
      )}
      {(c.status === "active" || c.status === "paused") && (
        <Button
          size="slim"
          tone="critical"
          variant="plain"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete "${c.name}" permanently from Meta?`)) {
              remove(c.id);
            }
          }}
        >
          Delete
        </Button>
      )}
      {(c.status === "draft" || c.status === "failed") && (
        <Button
          size="slim"
          tone="critical"
          variant="plain"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete draft "${c.name}"?`)) {
              remove(c.id);
            }
          }}
        >
          Delete
        </Button>
      )}
      {c.status === "failed" && c.funnelGroupId && (
        <Button
          size="slim"
          disabled={busy || funnelRetry.state === "submitting"}
          loading={funnelRetry.state === "submitting"}
          onClick={() => retryFunnel(c.funnelGroupId!)}
        >
          ↻ Retry funnel
        </Button>
      )}
      {c.status === "failed" && !c.funnelGroupId && (
        <Button size="slim" disabled={busy} onClick={() => retryStandalone(c.id)}>
          ↻ Retry publish
        </Button>
      )}
      {c.status === "draft" && (
        <Button size="slim" variant="plain" url={`/app/ads/create?edit=${c.id}`}>
          Edit
        </Button>
      )}
      <Button
        size="slim"
        variant="plain"
        disabled={analyzing === c.id}
        loading={analyzing === c.id}
        onClick={() => analyze(c.id, c.name)}
      >
        📊 Analyze
      </Button>
    </InlineStack>,
  ]);

  const metaRows = metaCampaigns.map((c) => [
    c.name,
    c.objective,
    statusBadge(c.status),
    c.dailyBudget != null ? `${formatMoney(c.dailyBudget, c.currency)}/day` : "—",
    c.adAccountName,
    <InlineStack key={c.id} gap="200" align="start">
      <Badge tone="info">Meta</Badge>
      <Button
        size="slim"
        variant="plain"
        disabled={analyzing === c.id}
        loading={analyzing === c.id}
        onClick={() => analyzeMeta(c.id, c.metaCampaignId, c.adAccountId, c.name)}
      >
        📊 Analyze
      </Button>
    </InlineStack>,
  ]);

  return (
    <Page
      title="Campaigns"
      backAction={{ url: "/app/ads" }}
      primaryAction={{ content: "Create campaign", url: "/app/ads/create" }}
      secondaryActions={[
        { content: "↻ Refresh from Meta", url: "/app/ads/campaigns?refresh=1" },
      ]}
    >
      <BlockStack gap="500">
        <Anim index={0}>
          <Hero
            title="Campaigns"
            subtitle="Toggle, analyze and manage your Meta campaigns"
          />
        </Anim>
        {published && (
          <Anim index={1}>
            <Banner tone="success">
              Your campaign is live! Meta may take a few minutes to approve it.
            </Banner>
          </Anim>
        )}
        <Anim index={1}>
          <div className="ap-card-hover">
            <Card>
              {campaigns.length === 0 ? (
                <EmptyState
                  heading="No campaigns yet"
                  action={{ content: "Create campaign", url: "/app/ads/create" }}
                  image=""
                >
                  <p>Create your first campaign in under 2 minutes.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Name", "Objective", "Status", "Budget", "Ad account", "Actions"]}
                  rows={rows}
                />
              )}
            </Card>
          </div>
        </Anim>
        {analysis && (
          <Anim index={2}>
            <div className="ap-card-hover">
              <BlockStack gap="200">
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Button variant="plain" onClick={() => setAnalysis(null)}>
                    Close
                  </Button>
                </div>
                <CampaignAnalysis
                  raw={analysis.text}
                  insights={analysis.insights}
                  campaignName={analysis.campaignName}
                  currency={analysis.currency}
                />
              </BlockStack>
            </div>
          </Anim>
        )}
        {metaFetchError && (
          <Anim index={2}>
            <Banner tone="warning">
              Could not load live Meta campaigns: {metaFetchError}
            </Banner>
          </Anim>
        )}
        {adAccountCount > 0 && (
          <Anim index={3}>
            <div className="ap-card-hover">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    From Meta Ads Manager
                  </Text>
                  {metaRows.length > 0 ? (
                    <>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Campaigns created directly in Meta — shown for reference.
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                        headings={["Name", "Objective", "Status", "Budget", "Ad account", "Actions"]}
                        rows={metaRows}
                      />
                    </>
                  ) : !metaFetchError ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {metaFetchAttempted
                        ? "No campaigns found in your Meta ad accounts."
                        : "Loading Meta campaigns…"}
                    </Text>
                  ) : null}
                </BlockStack>
              </Card>
            </div>
          </Anim>
        )}
      </BlockStack>
    </Page>
  );
}
