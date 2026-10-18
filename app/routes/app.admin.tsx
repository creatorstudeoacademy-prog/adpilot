import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Banner,
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
import { useEffect, useState } from "react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { listProvidersAsync, resolveProviders } from "../lib/ai.server";
import {
  createProvider,
  deleteProvider,
  listDbProviderMetas,
  setProviderEnabled,
  updateProvider,
  type DbProviderMeta,
} from "../lib/ai-providers.server";
import {
  SECTORS,
  SECTOR_LABELS,
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
  /** scheduled | active | expiring_soon | expired — computed server-side. */
  status: string;
};

/**
 * GET /app/admin — owner-only AI CONTROL panel.
 * Visible ONLY when the shop matches ADMIN_SHOP_DOMAIN env var.
 * Manage AI providers and agents here. Work-output statistics are
 * intentionally NOT shown on this page (control only).
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

interface ProviderInfo {
  /** DB row id, or null for env-var providers (read-only here). */
  id: string | null;
  name: string;
  type: string;
  model: string;
  /** "db" = added in this panel (editable), "env" = Railway env vars (read-only). */
  source: "db" | "env";
  keyConfigured: boolean;
  /** Last 4 chars of the key (DB providers only) — safe for display. */
  keyHint: string | null;
  enabled: boolean;
  /** Try-order within its source (lower = first). Env rows show list position. */
  sortOrder: number;
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const adminShop = (process.env.ADMIN_SHOP_DOMAIN ?? "").trim();
  if (!adminShop || session.shop !== adminShop) {
    throw new Response("Not found", { status: 404 });
  }

  const now = new Date();
  const month = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const delegate = activityLog();
  const rows = delegate
    ? await delegate.findMany({
        where: { createdAt: { gte: month } },
        orderBy: { createdAt: "desc" },
        take: 5000,
      })
    : [];

  // ── AI providers (keys NEVER leave the server) ──
  // DB providers added in this panel (sortOrder asc) first, then Railway
  // env-var providers. A DB provider whose name matches an env slot wins.
  const dbMetas: DbProviderMeta[] = await listDbProviderMetas().catch((e) => {
    console.error(`[adpilot admin] listDbProviderMetas failed: ${e instanceof Error ? e.message : e}`);
    return [];
  });
  const envCfgs = resolveProviders();
  const dbNames = new Set(dbMetas.map((m) => m.name));
  const providers: ProviderInfo[] = [
    ...dbMetas.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      model: m.model,
      source: "db" as const,
      keyConfigured: true,
      keyHint: m.keyHint,
      enabled: m.enabled,
      sortOrder: m.sortOrder,
      endpoint: m.type === "anthropic" ? "api.anthropic.com" : m.baseUrl,
      generations30d: 0,
    })),
    ...envCfgs
      .filter((p) => !dbNames.has(p.name))
      .map((p, i) => ({
        id: null,
        name: p.name,
        type: p.type,
        model: p.model,
        source: "env" as const,
        keyConfigured: Boolean(p.apiKey),
        keyHint: null,
        enabled: true,
        sortOrder: i,
        endpoint: p.type === "anthropic" ? "api.anthropic.com" : p.baseUrl,
        generations30d: 0,
      })),
  ];
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

  const agents = await listAgents();
  const providerNames = await listProvidersAsync();
  // Serialize Dates for the client (useLoaderData JSON).
  const agentsJson: ClientAgent[] = agents.map((a) => ({
    ...a,
    activeFrom: a.activeFrom ? a.activeFrom.toISOString() : null,
    expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    status: getAgentStatus(a),
  }));

  return json({ providers, aiFailures, skills: AI_SKILLS, agents: agentsJson, providerNames, coupons: await listCoupons(), couponStats: await couponStats() });
};

async function listCoupons() {
  try {
    const all = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { redemptions: true } } },
    });
    return all.map((c) => ({
      code: c.code,
      bonusPercent: c.bonusPercent,
      fixedBonus: c.fixedBonus,
      expiresAt: c.expiresAt.toISOString(),
      active: c.active,
      uses: c._count.redemptions,
    }));
  } catch {
    return [];
  }
}

async function couponStats() {
  try {
    const [created, sent, used, couponTopups] = await Promise.all([
      prisma.coupon.count(),
      prisma.shopCoupon.count(),
      prisma.couponRedemption.count(),
      prisma.walletTransaction.findMany({
        where: { description: { contains: "coupon" } },
        select: { amount: true },
      }),
    ]);
    const topupRevenue = couponTopups
      .filter((t) => t.amount > 0)
      .reduce((s, t) => s + t.amount, 0);
    return {
      created,
      sent,
      used,
      topupRevenue: Math.round(topupRevenue * 100) / 100,
      topupCount: couponTopups.filter((t) => t.amount > 0).length,
    };
  } catch {
    return { created: 0, sent: 0, used: 0, topupRevenue: 0, topupCount: 0 };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const adminShop = (process.env.ADMIN_SHOP_DOMAIN ?? "").trim();
  if (!adminShop || session.shop !== adminShop) {
    throw new Response("Not found", { status: 404 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const providerError = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return json(
        { providerError: e instanceof Error ? e.message : "Failed." },
        { status: 400 },
      );
    }
    return redirect("/app/admin");
  };
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
    } else if (intent === "create-provider") {
      return providerError(() =>
        createProvider({
          name: String(form.get("name") ?? ""),
          type: String(form.get("type") ?? ""),
          key: String(form.get("key") ?? ""),
          model: String(form.get("model") ?? ""),
          baseUrl: String(form.get("baseUrl") ?? ""),
          enabled: form.get("enabled") === "on",
        }),
      );
    } else if (intent === "update-provider") {
      return providerError(() =>
        updateProvider(String(form.get("providerId") ?? ""), {
          type: String(form.get("type") ?? "") || undefined,
          key: String(form.get("key") ?? "") || undefined,
          model: String(form.get("model") ?? "") || undefined,
          baseUrl: form.get("baseUrl") !== null ? String(form.get("baseUrl")) : undefined,
          sortOrder:
            form.get("sortOrder") !== null && String(form.get("sortOrder")).trim() !== ""
              ? Number(form.get("sortOrder"))
              : undefined,
          enabled: form.get("enabled") === "on",
        }),
      );
    } else if (intent === "toggle-provider") {
      return providerError(() =>
        setProviderEnabled(
          String(form.get("providerId") ?? ""),
          form.get("enabled") === "on",
        ),
      );
    } else if (intent === "delete-provider") {
      return providerError(() => deleteProvider(String(form.get("providerId") ?? "")));
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

function AgentTest({ agentId }: { agentId: string }) {
  const fetcher = useFetcher<{
    ok: boolean;
    agent?: string;
    provider?: string;
    latencyMs?: number;
    output?: string;
    error?: string;
    message?: string;
  }>();
  const data = fetcher.data;
  const testing = fetcher.state !== "idle";
  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      <fetcher.Form action="/api/admin/ai-test" method="post">
        <input type="hidden" name="agentId" value={agentId} />
        <Button submit size="slim" loading={testing}>
          Test
        </Button>
      </fetcher.Form>
      {data && data.ok && (
        <Text as="p" variant="bodySm" tone="success">
          Live via {data.provider} ({((data.latencyMs ?? 0) / 1000).toFixed(1)}
          s): &ldquo;{(data.output ?? "").slice(0, 60)}&rdquo;
        </Text>
      )}
      {data && !data.ok && (
        <Text as="p" variant="bodySm" tone="critical">
          {data.message || data.error}
        </Text>
      )}
    </InlineStack>
  );
}

function ProvidersSection({
  providers,
  aiFailures,
  actionError,
}: {
  providers: ProviderInfo[];
  aiFailures: Array<{ time: string; shop: string; message: string }>;
  actionError?: string;
}) {
  // Add-form state — all TextFields are CONTROLLED (uncontrolled Polaris
  // TextFields silently dropped keystrokes here before; see agent-name fix).
  const [pName, setPName] = useState("");
  const [pType, setPType] = useState("openai");
  const [pKey, setPKey] = useState("");
  const [pModel, setPModel] = useState("");
  const [pBaseUrl, setPBaseUrl] = useState("");
  const [pEnabled, setPEnabled] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing =
    providers.find((p) => p.id === editingId && p.source === "db") ?? null;

  const typeLabel = (t: string) =>
    t === "anthropic" ? "Anthropic" : "OpenAI-compatible";

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          AI providers
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Providers added here are tried first (in list order), then Railway
          env-var providers. API keys are encrypted before storage and never
          shown — only the last 4 characters. A provider with the same name as
          a Railway variable overrides it.
        </Text>
        {actionError && (
          <Text as="p" variant="bodySm" tone="critical">
            {actionError}
          </Text>
        )}

        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Add provider
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="create-provider" />
            <BlockStack gap="300">
              <Grid>
                <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                  <TextField
                    label="Name"
                    name="name"
                    placeholder="e.g. groq"
                    helpText="Lowercase letters, digits, dashes."
                    value={pName}
                    onChange={setPName}
                    autoComplete="off"
                  />
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                  <Select
                    label="Type"
                    name="type"
                    options={[
                      { label: "OpenAI-compatible", value: "openai" },
                      { label: "Anthropic", value: "anthropic" },
                    ]}
                    value={pType}
                    onChange={setPType}
                  />
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                  <TextField
                    label="API key"
                    name="key"
                    type="password"
                    value={pKey}
                    onChange={setPKey}
                    autoComplete="off"
                  />
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                  <TextField
                    label="Model"
                    name="model"
                    placeholder="e.g. llama-3.3-70b-versatile"
                    value={pModel}
                    onChange={setPModel}
                    autoComplete="off"
                  />
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                  <TextField
                    label="Base URL (optional)"
                    name="baseUrl"
                    placeholder="https://api.groq.com/openai/v1"
                    helpText="Only for OpenAI-compatible endpoints."
                    value={pBaseUrl}
                    onChange={setPBaseUrl}
                    autoComplete="off"
                  />
                </Grid.Cell>
              </Grid>
              <InlineStack gap="300" blockAlign="center">
                <Checkbox
                  label="Enabled"
                  checked={pEnabled}
                  onChange={setPEnabled}
                />
                <input type="hidden" name="enabled" value={pEnabled ? "on" : "off"} />
                <Button submit>Add provider</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </BlockStack>

        {providers.length === 0 ? (
          <Text as="p" variant="bodyMd" tone="critical">
            No AI provider configured. Add one with the form above, or set
            AI_PROVIDER_ORDER and AI_&lt;NAME&gt;_KEY / AI_&lt;NAME&gt;_MODEL in
            Railway variables and redeploy.
          </Text>
        ) : (
          <DataTable
            columnContentTypes={[
              "text",
              "text",
              "text",
              "text",
              "text",
              "text",
              "text",
              "numeric",
              "text",
            ]}
            headings={[
              "Name",
              "Type",
              "Model",
              "Key",
              "Source",
              "Status",
              "Generations (30d)",
              "",
              "",
            ]}
            rows={providers.map((p) => [
              p.name,
              typeLabel(p.type),
              p.model,
              p.source === "db" ? `••••${p.keyHint ?? ""}` : p.keyConfigured ? "✓ configured" : "✗ missing",
              p.source === "db" ? (
                <Badge key={`src-${p.id}`}>Admin panel</Badge>
              ) : (
                <Badge key={`src-${p.name}`} tone="info">
                  Railway
                </Badge>
              ),
              p.source === "db" ? (p.enabled ? "Enabled" : "Disabled") : "Always on",
              String(p.generations30d),
              p.source === "db" && p.id ? (
                <InlineStack key={`acts-${p.id}`} gap="100">
                  <Button size="slim" onClick={() => setEditingId(p.id)}>
                    Edit
                  </Button>
                  <Form method="post">
                    <input type="hidden" name="intent" value="toggle-provider" />
                    <input type="hidden" name="providerId" value={p.id} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={p.enabled ? "off" : "on"}
                    />
                    <Button submit size="slim">
                      {p.enabled ? "Disable" : "Enable"}
                    </Button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete-provider" />
                    <input type="hidden" name="providerId" value={p.id} />
                    <Button submit size="slim" tone="critical">
                      Delete
                    </Button>
                  </Form>
                </InlineStack>
              ) : (
                <Text key={`ro-${p.name}`} as="span" variant="bodySm" tone="subdued">
                  Manage in Railway
                </Text>
              ),
              "",
            ])}
          />
        )}

        {editing && (
          <ProviderEditForm
            key={editing.id}
            provider={editing}
            onCancel={() => setEditingId(null)}
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
  );
}

function ProviderEditForm({
  provider,
  onCancel,
}: {
  provider: ProviderInfo;
  onCancel: () => void;
}) {
  const [eType, setEType] = useState(provider.type);
  const [eModel, setEModel] = useState(provider.model);
  const [eKey, setEKey] = useState("");
  const [eBaseUrl, setEBaseUrl] = useState(
    provider.endpoint && provider.type !== "anthropic" ? provider.endpoint : "",
  );
  const [eEnabled, setEEnabled] = useState(provider.enabled);
  const [eSortOrder, setESortOrder] = useState(String(provider.sortOrder ?? 0));
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Edit provider “{provider.name}”
        </Text>
        <Form method="post">
          <input type="hidden" name="intent" value="update-provider" />
          <input type="hidden" name="providerId" value={provider.id ?? ""} />
          <BlockStack gap="300">
            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                <Select
                  label="Type"
                  name="type"
                  options={[
                    { label: "OpenAI-compatible", value: "openai" },
                    { label: "Anthropic", value: "anthropic" },
                  ]}
                  value={eType}
                  onChange={setEType}
                />
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <TextField
                  label="Model"
                  name="model"
                  value={eModel}
                  onChange={setEModel}
                  autoComplete="off"
                />
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                <TextField
                  label="Priority (lower = tried first)"
                  name="sortOrder"
                  type="number"
                  value={eSortOrder}
                  onChange={setESortOrder}
                  autoComplete="off"
                />
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <TextField
                  label="New API key (optional)"
                  name="key"
                  type="password"
                  placeholder="Leave blank to keep the current key"
                  helpText="Only fill this in to rotate the key."
                  value={eKey}
                  onChange={setEKey}
                  autoComplete="off"
                />
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                <TextField
                  label="Base URL"
                  name="baseUrl"
                  helpText="Only for OpenAI-compatible endpoints. Empty = provider default."
                  value={eBaseUrl}
                  onChange={setEBaseUrl}
                  autoComplete="off"
                />
              </Grid.Cell>
            </Grid>
            <InlineStack gap="300" blockAlign="center">
              <Checkbox
                label="Enabled"
                checked={eEnabled}
                onChange={setEEnabled}
              />
              <input type="hidden" name="enabled" value={eEnabled ? "on" : "off"} />
              <Button submit>Save changes</Button>
              <Button onClick={onCancel}>Cancel</Button>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Agents using this provider keep working — the name cannot be
              changed (delete and recreate to rename).
            </Text>
          </BlockStack>
        </Form>
      </BlockStack>
    </Card>
  );
}

function AgentsSection({
  agents,
  providerNames,
  actionError,
}: {
  agents: ClientAgent[];
  providerNames: string[];
  actionError?: string;
}) {
  const [sectors, setSectors] = useState<string[]>(["all"]);
  const [priority, setPriority] = useState("0");
  const [agentName, setAgentName] = useState("");
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
                      value={agentName}
                      onChange={setAgentName}
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
                    ...SECTORS.map((s) => ({ label: SECTOR_LABELS[s], value: s })),
                  ]}
                  selected={sectors}
                  onChange={setSectors}
                />
                {sectors.map((s) => (
                  <input key={s} type="hidden" name="sectors" value={s} />
                ))}
                <Checkbox
                  label="Enabled"
                  checked={enabled}
                  onChange={setEnabled}
                />
                <input type="hidden" name="enabled" value={enabled ? "on" : "off"} />
                <Checkbox
                  label="Main agent"
                  checked={isMain}
                  onChange={setIsMain}
                  helpText="Main agent handles any sector no specialized agent covers. If several are flagged, the lowest priority wins."
                />
                <input type="hidden" name="isMainAgent" value={isMain ? "on" : "off"} />
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
              rows={agents.map((a) => [
                a.isMainAgent ? `⭐ ${a.name}` : a.name,
                a.providerName ?? "—",
                a.isMainAgent ? "all (main)" : a.sectors,
                String(a.priority ?? 0),
                <Text as="span" variant="bodySm" tone={statusTone(a.status)}>
                  {a.status.replace("_", " ")}{a.enabled ? "" : " (disabled)"}
                </Text>,
                a.activeFrom ? a.activeFrom.slice(0, 10) : "—",
                a.expiresAt ? a.expiresAt.slice(0, 10) : "—",
                <AgentUpload
                  key={`up-${a.id}`}
                  agentId={a.id}
                  fileName={a.rulesFileName ?? null}
                />,
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <AgentTest key={`test-${a.id}`} agentId={a.id} />
                  <Form key={`del-${a.id}`} method="post">
                    <input type="hidden" name="intent" value="delete-agent" />
                    <input type="hidden" name="agentId" value={a.id} />
                    <Button submit tone="critical" size="slim">
                      Delete
                    </Button>
                  </Form>
                </InlineStack>,
              ])}
            />
          )}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

export default function AdminControlPanel() {
  const { providers, aiFailures, skills, agents, providerNames, coupons, couponStats } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<{ agentError?: string; providerError?: string }>();
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedMsg, setSeedMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newCode, setNewCode] = useState("");
  const [newBonus, setNewBonus] = useState("10");
  const [newFixed, setNewFixed] = useState("");
  const [newDays, setNewDays] = useState("30");
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [couponReqs, setCouponReqs] = useState<Array<{
    id: string;
    shop: string;
    message: string;
    status: string;
    createdAt: string;
  }>>([]);
  const [newShops, setNewShops] = useState<Array<{ shop: string; since: string }>>([]);
  const [sendCouponCode, setSendCouponCode] = useState<Record<string, string>>({});
  const [sendBusy, setSendBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/coupon-requests")
      .then((r) => r.json())
      .then((d) => {
        setCouponReqs((d.requests ?? []).filter((r: { status: string }) => r.status === "pending"));
        setNewShops(d.newShops ?? []);
      })
      .catch(() => {});
  }, [seedMsg, genMsg]);

  const sendCouponToRequest = async (requestId: string) => {
    const code = sendCouponCode[requestId];
    const coupon = coupons.find((c) => c.code === code);
    if (!coupon) return;
    // Need coupon id — fetch from list
    setSendBusy(requestId);
    try {
      const res = await fetch("/api/admin/coupon-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", requestId, couponCode: code }),
      });
      const data = await res.json();
      if (data.ok) {
        setCouponReqs((prev) => prev.filter((r) => r.id !== requestId));
      }
    } finally {
      setSendBusy(null);
    }
  };

  const sendCouponToShop = async (shop: string) => {
    const code = sendCouponCode[shop];
    if (!code) return;
    setSendBusy(shop);
    try {
      const res = await fetch("/api/admin/coupon-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send-to-shop", shop, couponCode: code }),
      });
      const data = await res.json();
      if (data.ok) {
        setNewShops((prev) => prev.filter((s) => s.shop !== shop));
      }
    } finally {
      setSendBusy(null);
    }
  };

  const seedCoupons = async () => {
    setSeedBusy(true);
    setSeedMsg(null);
    try {
      const res = await fetch("/api/admin/seed-coupons", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setSeedMsg({ ok: true, text: `Seeded! ${data.created} new coupon(s) created.` });
      } else {
        setSeedMsg({ ok: false, text: data.error || "Seeding failed." });
      }
    } catch {
      setSeedMsg({ ok: false, text: "Couldn't reach the server." });
    } finally {
      setSeedBusy(false);
    }
  };

  const generateCoupon = async () => {
    setGenBusy(true);
    setGenMsg(null);
    try {
      const res = await fetch("/api/admin/create-coupon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCode,
          bonusPercent: Number(newBonus),
          fixedBonus: newFixed ? Number(newFixed) : undefined,
          daysValid: Number(newDays),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setGenMsg({
          ok: true,
          text: `✓ Coupon ${data.coupon.code} created — ${data.coupon.fixedBonus != null ? `$${data.coupon.fixedBonus} fixed bonus` : `${data.coupon.bonusPercent}% bonus`}, expires ${new Date(data.coupon.expiresAt).toLocaleDateString()}.`,
        });
        setNewCode("");
      } else {
        setGenMsg({ ok: false, text: data.error || "Couldn't create coupon." });
      }
    } catch {
      setGenMsg({ ok: false, text: "Couldn't reach the server." });
    } finally {
      setGenBusy(false);
    }
  };
  return (
    <Page title="AI Control Panel" subtitle="Manage AI providers and agents">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <ProvidersSection
              providers={providers}
              aiFailures={aiFailures}
              actionError={actionData?.providerError}
            />

            <AgentsSection
              agents={agents}
              providerNames={providerNames}
              actionError={actionData?.agentError}
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
                  Provider keys are managed in the AI providers section above
                  (add / edit / enable / disable). Per-skill enable/disable and
                  fees are still managed via app/lib/pricing.ts.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  🎟️ Coupon codes
                </Text>

                {/* Stats dashboard */}
                <Grid>
                  {[
                    { label: "Created", value: String(couponStats.created), icon: "🎟️" },
                    { label: "Sent", value: String(couponStats.sent), icon: "📨" },
                    { label: "Used", value: String(couponStats.used), icon: "✅" },
                    { label: "Coupon top-ups", value: `$${couponStats.topupRevenue.toFixed(2)} (${couponStats.topupCount})`, icon: "💰" },
                  ].map((s) => (
                    <Grid.Cell key={s.label} columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                      <Box
                        background="bg-surface-secondary"
                        borderRadius="200"
                        padding="300"
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodySm" tone="subdued">
                            {s.icon} {s.label}
                          </Text>
                          <Text as="p" variant="headingLg">
                            {s.value}
                          </Text>
                        </BlockStack>
                      </Box>
                    </Grid.Cell>
                  ))}
                </Grid>

                <Text as="p" variant="bodyMd" tone="subdued">
                  Seed the default coupon codes (WELCOME10, LAUNCH15, BOOST10,
                  GROW20, ADS10) with expiry dates. Safe to run multiple times —
                  existing codes are skipped.
                </Text>
                <InlineStack>
                  <Button
                    loading={seedBusy}
                    onClick={() => void seedCoupons()}
                  >
                    Seed coupon codes
                  </Button>
                </InlineStack>
                {seedMsg && (
                  <Banner tone={seedMsg.ok ? "success" : "critical"}>
                    {seedMsg.text}
                  </Banner>
                )}

                <Text as="h3" variant="headingSm">
                  Generate new coupon
                </Text>
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
                    <TextField
                      label="Code"
                      value={newCode}
                      onChange={(v) => setNewCode(v.toUpperCase())}
                      placeholder="e.g. FIRST50"
                      autoComplete="off"
                      helpText="A-Z and 0-9 only, min 4 chars"
                    />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 3, sm: 3, md: 4, lg: 4, xl: 4 }}>
                    <TextField
                      label="Bonus %"
                      type="number"
                      value={newBonus}
                      onChange={setNewBonus}
                      autoComplete="off"
                      suffix="%"
                      placeholder="10"
                    />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 3, sm: 3, md: 3, lg: 3, xl: 3 }}>
                    <TextField
                      label="Fixed $ bonus"
                      type="number"
                      value={newFixed}
                      onChange={setNewFixed}
                      autoComplete="off"
                      prefix="$"
                      placeholder="e.g. 1"
                      helpText="Optional — overrides %"
                    />
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 3, sm: 3, md: 3, lg: 3, xl: 3 }}>
                    <TextField
                      label="Valid for (days)"
                      type="number"
                      value={newDays}
                      onChange={setNewDays}
                      autoComplete="off"
                      suffix="days"
                      placeholder="30"
                    />
                  </Grid.Cell>
                </Grid>
                <InlineStack>
                  <Button
                    variant="primary"
                    loading={genBusy}
                    onClick={() => void generateCoupon()}
                  >
                    🎟️ Generate coupon
                  </Button>
                </InlineStack>
                {genMsg && (
                  <Banner tone={genMsg.ok ? "success" : "critical"}>
                    {genMsg.text}
                  </Banner>
                )}
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "text", "text"]}
                  headings={["Code", "Bonus", "Expires", "Status", "Uses"]}
                  rows={coupons.map((c) => [
                    c.code,
                    c.fixedBonus != null ? `$${c.fixedBonus} fixed` : `${c.bonusPercent}%`,
                    new Date(c.expiresAt).toLocaleDateString(),
                    c.active ? "Active" : "Disabled",
                    String(c.uses),
                  ])}
                />

                <Text as="h3" variant="headingSm">
                  📨 Coupon requests
                </Text>
                {couponReqs.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No pending requests.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {couponReqs.map((r) => (
                      <Box
                        key={r.id}
                        background="bg-surface-secondary"
                        borderRadius="200"
                        padding="300"
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="050">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {r.shop}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {new Date(r.createdAt).toLocaleDateString()}
                              {r.message && ` — "${r.message}"`}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="200" blockAlign="center">
                            <div style={{ minWidth: "150px" }}>
                              <Select
                                label="Coupon"
                                labelHidden
                                options={coupons
                                  .filter((c) => c.active)
                                  .map((c) => ({
                                    label: `${c.code} (${c.bonusPercent}%)`,
                                    value: c.code,
                                  }))}
                                value={sendCouponCode[r.id] ?? ""}
                                onChange={(v) =>
                                  setSendCouponCode((p) => ({ ...p, [r.id]: v }))
                                }
                              />
                            </div>
                            <Button
                              variant="primary"
                              size="slim"
                              loading={sendBusy === r.id}
                              disabled={!sendCouponCode[r.id]}
                              onClick={() => void sendCouponToRequest(r.id)}
                            >
                              Send
                            </Button>
                          </InlineStack>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}

                <Text as="h3" variant="headingSm">
                  🆕 New shops — one-click send
                </Text>
                {newShops.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No new shops waiting for a coupon.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {newShops.slice(0, 10).map((s) => (
                      <InlineStack key={s.shop} align="space-between" blockAlign="center">
                        <Text as="p" variant="bodyMd">
                          {s.shop}
                        </Text>
                        <InlineStack gap="200" blockAlign="center">
                          <div style={{ minWidth: "150px" }}>
                            <Select
                              label="Coupon"
                              labelHidden
                              options={coupons
                                .filter((c) => c.active)
                                .map((c) => ({
                                  label: `${c.code} (${c.bonusPercent}%)`,
                                  value: c.code,
                                }))}
                              value={sendCouponCode[s.shop] ?? ""}
                              onChange={(v) =>
                                setSendCouponCode((p) => ({ ...p, [s.shop]: v }))
                              }
                            />
                          </div>
                          <Button
                            size="slim"
                            loading={sendBusy === s.shop}
                            disabled={!sendCouponCode[s.shop]}
                            onClick={() => void sendCouponToShop(s.shop)}
                          >
                            Send
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
