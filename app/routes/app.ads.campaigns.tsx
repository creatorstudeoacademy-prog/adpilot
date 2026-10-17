import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCampaigns, toggleCampaign } from "../lib/meta-ads.server";

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
  await Promise.all(
    adAccounts.map(async (acct) => {
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
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
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
  const { published, campaigns, metaCampaigns, metaFetchError } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  const toggle = (id: string, activate: boolean) => {
    const data = new FormData();
    data.set("campaignId", id);
    data.set("activate", activate ? "1" : "0");
    submit(data, { method: "post" });
  };

  const rows = campaigns.map((c) => [
    c.name,
    c.objective,
    statusBadge(c.status),
    `$${c.dailyBudget.toFixed(2)}/day`,
    c.adAccountName,
    c.status === "active" ? (
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
    ),
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
        {metaFetchError && (
          <Banner tone="warning">
            Could not load live Meta campaigns: {metaFetchError}
          </Banner>
        )}
        {metaRows.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                From Meta Ads Manager
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Campaigns created directly in Meta — shown for reference.
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                headings={["Name", "Objective", "Status", "Budget", "Ad account", "Source"]}
                rows={metaRows}
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
