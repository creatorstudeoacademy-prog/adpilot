import { useState } from "react";
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
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const color = pct >= 70 ? "#108043" : pct >= 40 ? "#b98900" : "#bf0711";
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

/**
 * The Ad Strategy bar: analyzes 30 days of ad account data and
 * produces a concrete sales strategy (audience, placements, budget,
 * creative) — then one click applies it to a new campaign.
 */
export default function StrategyBar() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string>("");

  const strategy = raw ? parseStrategy(raw) : null;
  const parseFailed = raw !== null && strategy === null;

  const analyze = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRaw(null);
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
      };
      if (!data.ok) throw new Error(data.message ?? "Analysis failed.");
      setRaw(data.strategy ?? "");
      setAccountName(data.accountName ?? "");
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
