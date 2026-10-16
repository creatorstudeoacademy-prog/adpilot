import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Card,
  DataTable,
  Grid,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveProviders } from "../lib/ai.server";
import { AI_GENERATION_FEE } from "../lib/pricing";

/**
 * GET /app/admin — owner-only AI activity report.
 * Visible ONLY when the shop matches ADMIN_SHOP_DOMAIN env var.
 * Shows what the AI did, how many merchants used it, and revenue earned.
 */

// Minimal typed access to ActivityLog (client regenerates at Docker build).
interface ActivityRow {
  shop: string;
  action: string;
  detail: string | null;
  feeCharged: number;
  createdAt: Date;
}
interface ActivityLogDelegate {
  findMany: (args: {
    where: { createdAt: { gte: Date } };
    orderBy?: { createdAt: "desc" };
    take?: number;
  }) => Promise<ActivityRow[]>;
}
function activityLog(): ActivityLogDelegate | undefined {
  return (prisma as unknown as { activityLog?: ActivityLogDelegate }).activityLog;
}

const ACTIONS = [
  "ai_generate",
  "post_publish",
  "post_schedule",
  "ad_publish",
  "audience_create",
  "wallet_topup",
] as const;

const ACTION_LABELS: Record<string, string> = {
  ai_generate: "AI generations",
  post_publish: "Posts published",
  post_schedule: "Posts scheduled",
  ad_publish: "Ads published",
  audience_create: "Audiences created",
  wallet_topup: "Wallet top-ups",
};

interface PeriodStats {
  label: string;
  counts: Record<string, number>;
  merchants: number;
  revenue: number;
}

interface ProviderInfo {
  name: string;
  type: string;
  model: string;
  keyConfigured: boolean;
  endpoint: string;
  generations30d: number;
}

interface AiFailure {
  time: string;
  shop: string;
  message: string;
}

interface AiSkill {
  id: string;
  name: string;
  description: string;
  fee: number;
  enabled: boolean;
}

const AI_SKILLS: AiSkill[] = [
  {
    id: "caption_generator",
    name: "AI Caption Generator",
    description: "Writes post captions + hashtags from a topic (Compose page).",
    fee: AI_GENERATION_FEE,
    enabled: true,
  },
];

function summarize(rows: ActivityRow[], since: Date): PeriodStats {
  const inPeriod = rows.filter((r) => r.createdAt >= since);
  const counts: Record<string, number> = {};
  for (const a of ACTIONS) counts[a] = 0;
  const shops = new Set<string>();
  let revenue = 0;
  for (const r of inPeriod) {
    if (r.action in counts) counts[r.action] += 1;
    shops.add(r.shop);
    revenue += r.feeCharged ?? 0;
  }
  return {
    label: "",
    counts,
    merchants: shops.size,
    revenue: Math.round(revenue * 100) / 100,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const adminShop = (process.env.ADMIN_SHOP_DOMAIN ?? "").trim();
  if (!adminShop || session.shop !== adminShop) {
    throw new Response("Not found", { status: 404 });
  }

  const now = new Date();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const month = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const delegate = activityLog();
  const rows = delegate
    ? await delegate.findMany({
        where: { createdAt: { gte: month } },
        orderBy: { createdAt: "desc" },
        take: 5000,
      })
    : [];

  const today = { ...summarize(rows, day), label: "Today" };
  const last7 = { ...summarize(rows, week), label: "Last 7 days" };
  const last30 = { ...summarize(rows, month), label: "Last 30 days" };

  // ── AI providers (keys NEVER leave the server) ──
  const providers: ProviderInfo[] = resolveProviders().map((p) => ({
    name: p.name,
    type: p.type,
    model: p.model,
    keyConfigured: Boolean(p.apiKey),
    endpoint: p.type === "anthropic" ? "api.anthropic.com" : p.baseUrl,
    generations30d: 0,
  }));
  const aiFailures: AiFailure[] = [];
  for (const r of rows) {
    if (r.action !== "ai_generate" || !r.detail) continue;
    const m = /provider:([a-z0-9_-]+)/i.exec(r.detail);
    if (m) {
      const p = providers.find((x) => x.name === m[1].toLowerCase());
      if (p) p.generations30d += 1;
    } else if (r.detail.startsWith("failed:")) {
      aiFailures.push({
        time: r.createdAt.toISOString().slice(0, 16).replace("T", " "),
        shop: r.shop,
        message: r.detail.slice("failed:".length).trim().slice(0, 90),
      });
    }
  }

  const recent = rows.slice(0, 25).map((r) => [
    r.createdAt.toISOString().slice(0, 16).replace("T", " "),
    r.shop,
    ACTION_LABELS[r.action] ?? r.action,
    r.detail ? r.detail.slice(0, 70) : "—",
    `$${(r.feeCharged ?? 0).toFixed(2)}`,
  ]);

  return json({ today, last7, last30, recent, providers, aiFailures, skills: AI_SKILLS });
};

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {title}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

function PeriodSection({ stats }: { stats: PeriodStats }) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          {stats.label}
        </Text>
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
            <StatCard title="Active merchants" value={String(stats.merchants)} />
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
            <StatCard title="Revenue" value={`$${stats.revenue.toFixed(2)}`} />
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
            <StatCard
              title="AI generations"
              value={String(stats.counts.ai_generate ?? 0)}
            />
          </Grid.Cell>
        </Grid>
        <DataTable
          columnContentTypes={["text", "numeric"]}
          headings={["Action", "Count"]}
          rows={ACTIONS.map((a) => [ACTION_LABELS[a], String(stats.counts[a] ?? 0)])}
        />
      </BlockStack>
    </Card>
  );
}

export default function AdminReport() {
  const { today, last7, last30, recent, providers, aiFailures, skills } =
    useLoaderData<typeof loader>();
  return (
    <Page title="AI Report" subtitle="What the AI did, who used it, what it earned">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <PeriodSection stats={today} />
            <PeriodSection stats={last7} />
            <PeriodSection stats={last30} />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  AI providers
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Tried in priority order (AI_PROVIDER_ORDER). API keys are
                  never shown here — they live in env vars (see AI_SETUP.md).
                </Text>
                {providers.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="critical">
                    No AI provider configured. Add AI_PROVIDER_ORDER and
                    AI_&lt;NAME&gt;_KEY / AI_&lt;NAME&gt;_MODEL in Railway
                    variables, then redeploy.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={[
                      "numeric",
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                      "numeric",
                    ]}
                    headings={[
                      "#",
                      "Name",
                      "Type",
                      "Model",
                      "Key",
                      "Endpoint",
                      "Generations (30d)",
                    ]}
                    rows={providers.map((p, i) => [
                      String(i + 1),
                      p.name,
                      p.type,
                      p.model,
                      p.keyConfigured ? "✓ configured" : "✗ missing",
                      p.endpoint,
                      String(p.generations30d),
                    ])}
                  />
                )}
                {aiFailures.length > 0 && (
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      Recent AI failures / fallbacks
                    </Text>
                    <DataTable
                      columnContentTypes={["text", "text", "text"]}
                      headings={["Time (UTC)", "Shop", "Error"]}
                      rows={aiFailures
                        .slice(0, 10)
                        .map((f) => [f.time, f.shop, f.message])}
                    />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  AI skills
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric"]}
                  headings={["Skill", "Description", "Status", "Fee"]}
                  rows={skills.map((s) => [
                    s.name,
                    s.description,
                    s.enabled ? "Enabled" : "Disabled",
                    `$${s.fee.toFixed(2)} / use`,
                  ])}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  Enable/disable and key editing from this dashboard is coming
                  later — for now keys and fees are managed via env vars and
                  app/lib/pricing.ts.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Recent activity
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "numeric"]}
                  headings={["Time (UTC)", "Shop", "Action", "Detail", "Fee"]}
                  rows={recent}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
