import { useEffect, useState } from "react";
import { Badge, Banner, BlockStack, Button, Card, InlineStack, Text } from "@shopify/polaris";

interface Strategy {
  score?: number;
  verdict?: string;
  bestAudience?: {
    ageMin?: number;
    ageMax?: number;
    genders?: string[];
    countries?: string[];
    reason?: string;
  };
  placements?: { mode?: string; detail?: string };
  budget?: { minDaily?: number; recommendedDaily?: number; currency?: string; note?: string };
  creativeGuidance?: string[];
  risks?: string[];
  recommendations?: Array<{ title?: string; detail?: string; priority?: string }>;
}

function tryParse(t: string): Strategy | null {
  try {
    const parsed = JSON.parse(t) as Strategy;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function parseStrategy(raw: string): Strategy | null {
  const t = raw.trim();
  // 1. Fenced block (complete).
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const p = tryParse(fence[1].trim());
    if (p) return p;
  }
  // 2. Whole text as JSON.
  const start = t.indexOf("{");
  if (start >= 0) {
    const p = tryParse(t.slice(start).trim());
    if (p) return p;
    // 3. Truncated JSON: cut at the last complete top-level field.
    //    Find the last "}," that closes a complete key, then close the object.
    const sliced = t.slice(start);
    const lastFieldEnd = sliced.lastIndexOf("},");
    if (lastFieldEnd > 0) {
      const p2 = tryParse(sliced.slice(0, lastFieldEnd + 1) + "}");
      if (p2) return p2;
    }
  }
  return null;
}

function ScoreRing({ score }: { score: number }) {
  const target = Math.max(0, Math.min(100, Math.round(score)));
  const [pct, setPct] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const dur = 1200;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setPct(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  const color = target >= 70 ? "#108043" : target >= 40 ? "#b98900" : "#bf0711";
  return (
    <div
      style={{
        width: 84,
        height: 84,
        borderRadius: "50%",
        background: `conic-gradient(${color} ${pct * 3.6}deg, #e9e9ec 0deg)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: "#fff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 700, color }}>{pct}</span>
        <span style={{ fontSize: 10, color: "#6d7175" }}>readiness</span>
      </div>
    </div>
  );
}

/** Animated horizontal bar chart (pure CSS, no library). */
function BarChart({ rows, currency }: { rows: ChartRow[]; currency: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);
  const max = Math.max(1, ...rows.map((r) => r.spend));
  if (rows.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        No spend data for this breakdown.
      </Text>
    );
  }
  return (
    <BlockStack gap="150">
      {rows.map((r, i) => (
        <div key={i} className="ap-anim-up" style={{ animationDelay: `${i * 0.08}s` }}>
          <InlineStack gap="200" blockAlign="center">
            <div style={{ width: 110, flexShrink: 0 }}>
              <Text as="p" variant="bodySm" fontWeight="semibold">
                {r.label}
              </Text>
            </div>
            <div style={{ flex: 1, height: 22, background: "#f1f1f4", borderRadius: 11, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: mounted ? `${Math.max(4, (r.spend / max) * 100)}%` : "0%",
                  borderRadius: 11,
                  background:
                    r.cpp != null && r.cpp > 0
                      ? "linear-gradient(90deg, #5c6ac4, #9c6ade)"
                      : "linear-gradient(90deg, #d2d5d9, #e9ebee)",
                  transition: "width 0.9s cubic-bezier(0.22, 1, 0.36, 1)",
                }}
              />
            </div>
            <div style={{ width: 150, flexShrink: 0, textAlign: "right" }}>
              <Text as="p" variant="bodySm">
                {currency} {r.spend.toFixed(2)}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {r.purchases} purch{r.purchases === 1 ? "" : "s"}
                {r.cpp != null ? ` · ${currency} ${r.cpp.toFixed(2)}/ea` : ""}
              </Text>
            </div>
          </InlineStack>
        </div>
      ))}
    </BlockStack>
  );
}

/** KPI stat card with count-up feel. */
function KpiCard({ label, value, sub, delay }: { label: string; value: string; sub?: string; delay: number }) {
  return (
    <div className="ap-anim-up" style={{ flex: 1, animationDelay: `${delay}s` }}>
      <Card>
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            {label}
          </Text>
          <Text as="p" variant="headingLg">
            {value}
          </Text>
          {sub && (
            <Text as="p" variant="bodySm" tone="subdued">
              {sub}
            </Text>
          )}
        </BlockStack>
      </Card>
    </div>
  );
}

/**
 * The Ad Strategy bar: analyzes 30 days of ad account data and
 * produces a concrete sales strategy (audience, placements, budget,
 * creative) — then one click applies it to a new campaign.
 */
interface ChartRow {
  label: string;
  spend: number;
  purchases: number;
  ctr: number;
  cpp: number | null;
}
interface ChartData {
  totals: { spend: number; impressions: number; clicks: number; purchases: number; ctr: number; currency: string };
  byCountry: ChartRow[];
  byAgeGender: ChartRow[];
  byPlatform: ChartRow[];
}

export default function StrategyBar() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string>("");
  const [chartData, setChartData] = useState<ChartData | null>(null);

  const strategy = raw ? parseStrategy(raw) : null;
  const parseFailed = raw !== null && strategy === null;

  const analyze = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRaw(null);
    setChartData(null);
    try {
      const res = await fetch("/api/ads/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        ok: boolean;
        message?: string;
        strategy?: string;
        accountName?: string;
        chartData?: ChartData;
      };
      if (!data.ok) throw new Error(data.message ?? "Analysis failed.");
      setRaw(data.strategy ?? "");
      setAccountName(data.accountName ?? "");
      setChartData(data.chartData ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  };

  const audience = strategy?.bestAudience;
  const applyParams = audience
    ? `ageMin=${audience.ageMin ?? 18}&ageMax=${audience.ageMax ?? 65}&country=${(audience.countries ?? ["US"])[0]}&budget=${strategy.budget?.recommendedDaily ?? 10}`
    : "";
  const applyUrl = `/app/ads/create${applyParams ? `?${applyParams}` : ""}`;
  // Funnel splits the total daily budget 50/30/20 across 3 stages — scale it up 3x.
  const funnelBudget = (strategy?.budget?.recommendedDaily ?? 10) * 3;
  const funnelParams = audience
    ? `ageMin=${audience.ageMin ?? 25}&ageMax=${audience.ageMax ?? 64}&country=${(audience.countries ?? ["US"])[0]}&budget=${funnelBudget}`
    : "";
  const funnelUrl = `/app/ads/funnel${funnelParams ? `?${funnelParams}` : ""}`;
  // Audience Manager reads the same params and auto-opens the creator.
  const audienceUrl = `/app/ads/audiences${applyParams ? `?${applyParams}` : ""}`;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="center">
          <span style={{ fontSize: 28 }}>📈</span>
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">
              Ad Strategy
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Analyzes your last 30 days of ad data — who buys, where they are,
              what placements work — and builds a budget-safe sales strategy.
            </Text>
          </BlockStack>
          <div style={{ marginLeft: "auto" }}>
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => void analyze()}>
              {raw ? "Re-analyze" : "Analyze my ad data"}
            </Button>
          </div>
        </InlineStack>

        {error && <Banner tone="critical">{error}</Banner>}

        {parseFailed && (
          <Banner tone="warning">
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                Analysis completed but the report format was unexpected. Raw result:
              </Text>
              <Text as="p" variant="bodySm">
                {raw}
              </Text>
            </BlockStack>
          </Banner>
        )}

        {strategy && (
          <BlockStack gap="300">
            <InlineStack gap="300" blockAlign="center">
              <ScoreRing score={strategy.score ?? 0} />
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  {accountName}
                </Text>
                <Text as="p" variant="bodySm">
                  {strategy.verdict ?? ""}
                </Text>
              </BlockStack>
              <div style={{ marginLeft: "auto" }}>
                <InlineStack gap="200">
                  <Button url={applyUrl} variant="primary">
                    ✨ Apply to campaign
                  </Button>
                  <Button url={funnelUrl}>
                    🚀 Apply to funnel
                  </Button>
                  <Button url={audienceUrl}>
                    🎯 Apply to audience
                  </Button>
                </InlineStack>
              </div>
            </InlineStack>

            {chartData && (
              <BlockStack gap="200">
                <InlineStack gap="200">
                  <KpiCard
                    label="💸 30-day spend"
                    value={`${chartData.totals.currency} ${chartData.totals.spend.toFixed(2)}`}
                    delay={0}
                  />
                  <KpiCard
                    label="🛒 Purchases"
                    value={String(chartData.totals.purchases)}
                    sub={
                      chartData.totals.purchases > 0
                        ? `${chartData.totals.currency} ${(chartData.totals.spend / chartData.totals.purchases).toFixed(2)} per purchase`
                        : "no purchases yet"
                    }
                    delay={0.08}
                  />
                  <KpiCard
                    label="👁️ Impressions"
                    value={chartData.totals.impressions.toLocaleString()}
                    sub={`${chartData.totals.ctr}% CTR`}
                    delay={0.16}
                  />
                </InlineStack>
                {chartData.byCountry.length > 0 && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      🌍 Spend by country
                    </Text>
                    <BarChart rows={chartData.byCountry} currency={chartData.totals.currency} />
                  </BlockStack>
                )}
                {chartData.byAgeGender.length > 0 && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      👥 Spend by age & gender
                    </Text>
                    <BarChart rows={chartData.byAgeGender} currency={chartData.totals.currency} />
                  </BlockStack>
                )}
                {chartData.byPlatform.length > 0 && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      📱 Spend by placement
                    </Text>
                    <BarChart rows={chartData.byPlatform} currency={chartData.totals.currency} />
                  </BlockStack>
                )}
              </BlockStack>
            )}

            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 1 }}>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    🎯 Best audience
                  </Text>
                  <Text as="p" variant="bodySm">
                    Age {strategy.bestAudience?.ageMin ?? "?"}–{strategy.bestAudience?.ageMax ?? "?"}
                    {" · "}
                    {(strategy.bestAudience?.genders ?? []).join(", ") || "all"}
                    {" · "}
                    {(strategy.bestAudience?.countries ?? []).join(", ") || "—"}
                  </Text>
                  {strategy.bestAudience?.reason && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {strategy.bestAudience.reason}
                    </Text>
                  )}
                </BlockStack>
              </div>
              <div style={{ flex: 1 }}>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    📍 Placements
                  </Text>
                  <Text as="p" variant="bodySm">
                    {(strategy.placements?.mode ?? "").toLowerCase() === "advantage"
                      ? "Advantage+ (automatic)"
                      : strategy.placements?.mode ?? "—"}
                  </Text>
                  {strategy.placements?.detail && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {strategy.placements.detail}
                    </Text>
                  )}
                </BlockStack>
              </div>
              <div style={{ flex: 1 }}>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    💰 Budget
                  </Text>
                  <Text as="p" variant="bodySm">
                    {strategy.budget?.currency ?? ""} {strategy.budget?.recommendedDaily ?? "—"}/day
                    {strategy.budget?.minDaily != null &&
                      ` (min ${strategy.budget.currency ?? ""} ${strategy.budget.minDaily})`}
                  </Text>
                  {strategy.budget?.note && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {strategy.budget.note}
                    </Text>
                  )}
                </BlockStack>
              </div>
            </InlineStack>

            {(strategy.creativeGuidance ?? []).length > 0 && (
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  🎨 Creative guidance
                </Text>
                {(strategy.creativeGuidance ?? []).map((c, i) => (
                  <Text key={i} as="p" variant="bodySm">
                    • {c}
                  </Text>
                ))}
              </BlockStack>
            )}

            {(strategy.risks ?? []).length > 0 && (
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  ⚠️ Budget risks
                </Text>
                {(strategy.risks ?? []).map((r, i) => (
                  <Text key={i} as="p" variant="bodySm" tone="critical">
                    • {r}
                  </Text>
                ))}
              </BlockStack>
            )}

            {(strategy.recommendations ?? []).length > 0 && (
              <BlockStack gap="150">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  ✅ Recommended actions
                </Text>
                {(strategy.recommendations ?? []).map((rec, i) => (
                  <InlineStack key={i} gap="200" blockAlign="start">
                    <Badge
                      tone={
                        rec.priority === "high"
                          ? "critical"
                          : rec.priority === "medium"
                            ? "warning"
                            : "info"
                      }
                    >
                      {rec.priority ?? "low"}
                    </Badge>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        {rec.title ?? ""}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {rec.detail ?? ""}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
