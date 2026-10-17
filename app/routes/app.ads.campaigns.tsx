import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData, useSubmit, useNavigation, useSearchParams } from "@remix-run/react";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [campaigns, adAccounts] = await Promise.all([
    prisma.campaign.findMany({
      where: { shop },
      include: { adAccount: { select: { adAccountName: true } } },
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
        const list = await getCampaigns(acct.adAccountId, acct.accessToken);
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
      createdAt: c.createdAt,
      metaCampaignId: c.metaCampaignId,
      error: c.error,
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
  if (!campaign?.metaCampaignId) {
    return json({ ok: false, error: "Campaign not published to Meta yet." });
  }

  try {
    if (intent === "delete") {
      await deleteCampaign(campaign.metaCampaignId, campaign.adAccount.accessToken);
      await prisma.campaign.delete({ where: { id: campaign.id } });
      return json({ ok: true, deleted: true });
    }
    await toggleCampaign(campaign.metaCampaignId, campaign.adAccount.accessToken, activate);
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
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{ id: string; text: string } | null>(null);

  const analyze = async (id: string) => {
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
      setAnalysis({ id, text: data.analysis });
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
    `$${c.dailyBudget.toFixed(2)}/day`,
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
      <Button
        size="slim"
        variant="plain"
        disabled={analyzing === c.id}
        loading={analyzing === c.id}
        onClick={() => analyze(c.id)}
      >
        📊 Analyze
      </Button>
    </InlineStack>,
  ]);

  const metaRows = metaCampaigns.map((c) => [
    c.name,
    c.objective,
    statusBadge(c.status),
    c.dailyBudget != null ? `$${c.dailyBudget.toFixed(2)}/day` : "—",
    c.adAccountName,
    <Badge key={c.id} tone="info">
      Meta
    </Badge>,
  ]);

  return (
    <Page
      title="Campaigns"
      backAction={{ url: "/app/ads" }}
      primaryAction={{ content: "Create campaign", url: "/app/ads/create" }}
    >
      <BlockStack gap="500">
        {published && (
          <Banner tone="success">
            Your campaign is live! Meta may take a few minutes to approve it.
          </Banner>
        )}
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
        {analysis && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  📊 AI Campaign Analysis
                </Text>
                <Button variant="plain" onClick={() => setAnalysis(null)}>
                  Close
                </Button>
              </InlineStack>
              <Text as="p" variant="bodyMd">
                {analysis.text.split("\n").map((line, i) => (
                  <span key={i}>
                    {line}
                    <br />
                  </span>
                ))}
              </Text>
            </BlockStack>
          </Card>
        )}
        {metaFetchError && (
          <Banner tone="warning">
            Could not load live Meta campaigns: {metaFetchError}
          </Banner>
        )}
        {adAccountCount > 0 && (
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
                    headings={["Name", "Objective", "Status", "Budget", "Ad account", "Source"]}
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
        )}
      </BlockStack>
    </Page>
  );
}
