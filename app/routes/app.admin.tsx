import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useFetcher, useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  Checkbox,
  ChoiceList,
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
import { listProviders, resolveProviders } from "../lib/ai.server";
import {
  SECTORS,
} from "../lib/ai-sectors";
import {
  createAgent,
  deleteAgent,
  getAgentStatus,
  listAgents,
  type AgentRow,
} from "../lib/agents.server";
import { AI_GENERATION_FEE } from "../lib/pricing";

/** AgentRow as it arrives client-side via useLoaderData (Dates → ISO strings). */
type ClientAgent = Omit<AgentRow, "activeFrom" | "expiresAt" | "createdAt"> & {
  activeFrom: string | null;
  expiresAt: string | null;
  createdAt: string;
};

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
  agentName: string | null;
  app: string;
  createdAt: Date;
}
interface ActivityLogDelegate {
  findMany: (args: {
    where: { createdAt: { gte: Date }; agentName?: string; app?: string };
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

  const agents = await listAgents();
  const providerNames = listProviders();
  // Serialize Dates for the client (useLoaderData JSON).
  const agentsJson: ClientAgent[] = agents.map((a) => ({
    ...a,
    activeFrom: a.activeFrom ? a.activeFrom.toISOString() : null,
    expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  }));

  // ── Agent workload (per agent, from ActivityLog agentName) ──
  interface AgentWorkload {
    id: string;
    name: string;
    isMainAgent: boolean;
    enabled: boolean;
    sectors: string;
    activeFrom: string | null;
    expiresAt: string | null;
    status: string;
    today: number;
    last30d: number;
    success: number;
    failed: number;
    lastUsed: string | null;
  }
  const workload: AgentWorkload[] = agents.map((a) => {
    const mine = rows.filter((r) => r.agentName === a.name);
    const isFailed = (r: ActivityRow) => (r.detail ?? "").startsWith("failed:");
    const last = mine.length > 0 ? mine[0].createdAt : null; // rows are desc
    return {
      id: a.id,
      name: a.name,
      isMainAgent: a.isMainAgent,
      enabled: a.enabled,
      sectors: a.isMainAgent ? "all (main)" : a.sectors,
      activeFrom: a.activeFrom ? a.activeFrom.toISOString().slice(0, 10) : null,
      expiresAt: a.expiresAt ? a.expiresAt.toISOString().slice(0, 10) : null,
      status: getAgentStatus(a),
      today: mine.filter((r) => r.createdAt >= day).length,
      last30d: mine.length,
      success: mine.filter((r) => !isFailed(r)).length,
      failed: mine.filter(isFailed).length,
      lastUsed: last ? last.toISOString().slice(0, 16).replace("T", " ") : null,
    };
  });

  // ── App × agent matrix (forward-looking for the AI Hub; one row today) ──
  interface AppAgentRow {
    app: string;
    agents: string;
    tasks30d: number;
    revenue30d: number;
  }
  const appAgentMatrix: AppAgentRow[] = (() => {
    const byApp = new Map<string, { agents: Set<string>; tasks: number; revenue: number }>();
    for (const r of rows) {
      const app = r.app || "adpilot";
      let e = byApp.get(app);
      if (!e) {
        e = { agents: new Set(), tasks: 0, revenue: 0 };
        byApp.set(app, e);
      }
      if (r.agentName) e.agents.add(r.agentName);
      e.tasks += 1;
      e.revenue += r.feeCharged ?? 0;
    }
    return [...byApp.entries()].map(([app, e]) => ({
      app,
      agents: [...e.agents].join(", ") || "—",
      tasks30d: e.tasks,
      revenue30d: Math.round(e.revenue * 100) / 100,
    }));
  })();

  return json({ today, last7, last30, recent, providers, aiFailures, skills: AI_SKILLS, agents: agentsJson, providerNames, workload, appAgentMatrix });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const adminShop = (process.env.ADMIN_SHOP_DOMAIN ?? "").trim();
  if (!adminShop || session.shop !== adminShop) {
    throw new Response("Not found", { status: 404 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "create-agent") {
      const parseDate = (v: FormDataEntryValue | null): Date | null => {
        const s = String(v ?? "").trim();
        if (!s) return null;
        const d = new Date(s + "T00:00:00Z");
        return Number.isNaN(d.getTime()) ? null : d;
      };
      await createAgent({
        name: String(form.get("name") ?? ""),
        providerName: String(form.get("providerName") ?? ""),
        sectors: form.getAll("sectors").map(String).join(","),
        priority: Number(form.get("priority") ?? 0),
        enabled: form.get("enabled") === "on",
        isMainAgent: form.get("isMainAgent") === "on",
        activeFrom: parseDate(form.get("activeFrom")),
        expiresAt: parseDate(form.get("expiresAt")),
      });
    } else if (intent === "delete-agent") {
      await deleteAgent(String(form.get("agentId") ?? ""));
    } else {
      return json({ agentError: "Unknown action." }, { status: 400 });
    }
  } catch (e) {
    return json(
      { agentError: e instanceof Error ? e.message : "Failed." },
      { status: 400 },
    );
  }
  return redirect("/app/admin");
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

function AgentUpload({ agentId, fileName }: { agentId: string; fileName: string | null }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; message?: string; chars?: number; fileName?: string }>();
  const data = fetcher.data;
  return (
    <BlockStack gap="100">
      <fetcher.Form
        action="/api/ai/agents/upload"
        method="post"
        encType="multipart/form-data"
      >
        <input type="hidden" name="agentId" value={agentId} />
        <InlineStack gap="200" blockAlign="center">
          <input type="file" name="file" accept=".pdf,application/pdf" />
          <Button submit size="slim" loading={fetcher.state !== "idle"}>
            Upload rules PDF
          </Button>
        </InlineStack>
      </fetcher.Form>
      {fileName && (
        <Text as="p" variant="bodySm" tone="subdued">
          📄 {fileName}
        </Text>
      )}
      {data && !data.ok && (
        <Text as="p" variant="bodySm" tone="critical">
          {data.message || data.error}
        </Text>
      )}
      {data && data.ok && (
        <Text as="p" variant="bodySm" tone="success">
          Saved {data.chars} chars from {data.fileName}
        </Text>
      )}
    </BlockStack>
  );
}

function AgentsSection({
  agents,
  providerNames,
  actionError,
  workload,
  appAgentMatrix,
}: {
  agents: ClientAgent[];
  providerNames: string[];
  actionError?: string;
  workload: Array<{
    id: string;
    name: string;
    isMainAgent: boolean;
    enabled: boolean;
    sectors: string;
    activeFrom: string | null;
    expiresAt: string | null;
    status: string;
    today: number;
    last30d: number;
    success: number;
    failed: number;
    lastUsed: string | null;
  }>;
  appAgentMatrix: Array<{ app: string; agents: string; tasks30d: number; revenue30d: number }>;
}) {
  const [sectors, setSectors] = useState<string[]>(["all"]);
  const [priority, setPriority] = useState("0");
  const [enabled, setEnabled] = useState(true);
  const [isMain, setIsMain] = useState(false);
  const statusTone = (s: string) =>
    s === "active" ? undefined : s === "expired" ? "critical" : "caution";
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          AI agents
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          An agent = a named worker with a provider, assigned sectors, and
          working-rules text from an uploaded PDF. Routing order per sector:
          specialized agents (priority) → main agent → legacy provider order.
          Expired or not-yet-active agents are skipped by routing but stay
          visible here.
        </Text>

        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Create agent
          </Text>
          {providerNames.length === 0 ? (
            <Text as="p" variant="bodySm" tone="critical">
              Configure at least one AI provider first (see AI providers above).
            </Text>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="create-agent" />
              <BlockStack gap="300">
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <TextField
                      label="Agent name"
                      name="name"
                      placeholder="e.g. Caption Pro"
                      autoComplete="off"
                    />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                    <Select
                      label="Provider"
                      name="providerName"
                      options={providerNames.map((p) => ({ label: p, value: p }))}
                    />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                    <TextField
                      label="Priority (lower = first)"
                      name="priority"
                      type="number"
                      value={priority}
                      onChange={setPriority}
                      autoComplete="off"
                    />
                  </Grid.Cell>
                </Grid>
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Text as="p" variant="bodySm">
                      Active from
                    </Text>
                    <input type="date" name="activeFrom" />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Text as="p" variant="bodySm">
                      Expires at
                    </Text>
                    <input type="date" name="expiresAt" />
                  </Grid.Cell>
                </Grid>
                <ChoiceList
                  title="Sectors"
                  choices={[
                    { label: "All sectors", value: "all" },
                    ...SECTORS.map((s) => ({ label: s, value: s })),
                  ]}
                  selected={sectors}
                  onChange={setSectors}
                />
                {sectors.map((s) => (
                  <input key={s} type="hidden" name="sectors" value={s} />
                ))}
                <Checkbox
                  label="Enabled"
                  name="enabled"
                  checked={enabled}
                  onChange={setEnabled}
                />
                <Checkbox
                  label="Main agent"
                  name="isMainAgent"
                  checked={isMain}
                  onChange={setIsMain}
                  helpText="Main agent handles any sector no specialized agent covers. If several are flagged, the lowest priority wins."
                />
                {actionError && (
                  <Text as="p" variant="bodySm" tone="critical">
                    {actionError}
                  </Text>
                )}
                <InlineStack>
                  <Button submit variant="primary">
                    Create agent
                  </Button>
                </InlineStack>
              </BlockStack>
            </Form>
          )}
        </BlockStack>

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Agents ({agents.length})
          </Text>
          {agents.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No agents yet. The caption generator currently uses plain provider
              order.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text", "text"]}
              headings={[
                "Name",
                "Provider",
                "Sectors",
                "Priority",
                "Status",
                "Active from",
                "Expires",
                "Rules PDF",
                "",
              ]}
              rows={workload.map((w) => [
                w.isMainAgent ? `⭐ ${w.name}` : w.name,
                agents.find((a) => a.id === w.id)?.providerName ?? "—",
                w.sectors,
                String(agents.find((a) => a.id === w.id)?.priority ?? 0),
                <Text as="span" variant="bodySm" tone={statusTone(w.status)}>
                  {w.status.replace("_", " ")}{w.enabled ? "" : " (disabled)"}
                </Text>,
                w.activeFrom ?? "—",
                w.expiresAt ?? "—",
                <AgentUpload
                  key={`up-${w.id}`}
                  agentId={w.id}
                  fileName={agents.find((a) => a.id === w.id)?.rulesFileName ?? null}
                />,
                <Form key={`del-${w.id}`} method="post">
                  <input type="hidden" name="intent" value="delete-agent" />
                  <input type="hidden" name="agentId" value={w.id} />
                  <Button submit tone="critical" size="slim">
                    Delete
                  </Button>
                </Form>,
              ])}
            />
          )}
        </BlockStack>

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Agent workload (last 30 days)
          </Text>
          {workload.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No agents to report on yet.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "text"]}
              headings={["Agent", "Today", "30 days", "Success", "Failed", "Last used (UTC)"]}
              rows={workload.map((w) => [
                w.isMainAgent ? `⭐ ${w.name}` : w.name,
                String(w.today),
                String(w.last30d),
                String(w.success),
                String(w.failed),
                w.lastUsed ?? "—",
              ])}
            />
          )}
        </BlockStack>

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            App × agent breakdown
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Ready for the central AI Hub — one row per app, no schema change
            needed when more apps join.
          </Text>
          <DataTable
            columnContentTypes={["text", "text", "numeric", "numeric"]}
            headings={["App", "Agents active", "Tasks (30d)", "Revenue (30d)"]}
            rows={appAgentMatrix.map((r) => [
              r.app,
              r.agents,
              String(r.tasks30d),
              `$${r.revenue30d.toFixed(2)}`,
            ])}
          />
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

export default function AdminReport() {
  const { today, last7, last30, recent, providers, aiFailures, skills, agents, providerNames, workload, appAgentMatrix } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<{ agentError?: string }>();
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

            <AgentsSection
              agents={agents}
              providerNames={providerNames}
              actionError={actionData?.agentError}
              workload={workload}
              appAgentMatrix={appAgentMatrix}
            />

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
