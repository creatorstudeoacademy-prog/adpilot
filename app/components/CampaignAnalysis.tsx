import { Badge, BlockStack, Card, InlineStack, Text, Box, Grid } from "@shopify/polaris";

/**
 * CampaignAnalysis — designed report UI for AI campaign analysis.
 *
 * Takes the raw `analysis` string from /api/ai/analyze-campaign plus the
 * `insights` object. The API asks the AI for structured JSON; if parsing
 * fails (older responses, provider quirks) it falls back to a clean
 * markdown-lite renderer so the report never looks like raw text again.
 */

export interface AnalysisInsights {
  impressions?: number;
  reach?: number | null;
  clicks?: number;
  spend?: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
}

interface StructuredAnalysis {
  score?: number;
  verdict?: string;
  strengths?: string[];
  weaknesses?: string[];
  recommendations?: Array<{ title?: string; detail?: string; priority?: string }>;
}

function tryParseStructured(text: string): StructuredAnalysis | null {
  let t = text.trim();
  // Strip code fences if the model wrapped the JSON.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // Grab the outermost {...} in case of leading/trailing chatter.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const obj = JSON.parse(t) as StructuredAnalysis;
    if (obj && (Array.isArray(obj.strengths) || Array.isArray(obj.weaknesses) || Array.isArray(obj.recommendations))) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/** Render **bold** inline markup inside a string. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

/** Fallback renderer for plain markdown-ish text (headings, bullets, bold). */
function MarkdownFallback({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length > 0) {
      const items = list;
      list = [];
      blocks.push(
        <Box key={`l${blocks.length}`} paddingBlockEnd="200">
          <BlockStack gap="100">
            {items.map((it, i) => (
              <InlineStack key={i} gap="200" blockAlign="start" wrap={false}>
                <Text as="span" variant="bodyMd">•</Text>
                <Text as="span" variant="bodyMd">
                  <Rich text={it} />
                </Text>
              </InlineStack>
            ))}
          </BlockStack>
        </Box>,
      );
    }
  };
  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) {
      flushList();
      return;
    }
    const h = line.match(/^#{1,3}\s+(.*)/);
    if (h) {
      flushList();
      blocks.push(
        <Box key={`h${blocks.length}`} paddingBlockStart="200" paddingBlockEnd="100">
          <Text as="h3" variant="headingSm">
            <Rich text={h[1]} />
          </Text>
        </Box>,
      );
      return;
    }
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    flushList();
    blocks.push(
      <Box key={`p${blocks.length}`} paddingBlockEnd="100">
        <Text as="p" variant="bodyMd">
          <Rich text={line} />
        </Text>
      </Box>,
    );
  });
  flushList();
  return <BlockStack gap="100">{blocks}</BlockStack>;
}

function scoreTone(score: number): { label: string; tone: "success" | "warning" | "critical"; color: string } {
  if (score >= 70) return { label: "Strong", tone: "success", color: "#008060" };
  if (score >= 45) return { label: "Needs work", tone: "warning", color: "#b98900" };
  return { label: "Weak", tone: "critical", color: "#d72c0d" };
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="050">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="headingMd">{value}</Text>
      </BlockStack>
    </Box>
  );
}

const fmtInt = (n: number | undefined | null) =>
  n == null ? "—" : Math.round(n).toLocaleString("en-US");

export default function CampaignAnalysis({
  raw,
  insights,
  campaignName,
}: {
  raw: string;
  insights?: AnalysisInsights | null;
  campaignName?: string;
}) {
  const structured = tryParseStructured(raw);

  // ── Fallback: not JSON — render cleaned-up markdown instead of raw text ──
  if (!structured) {
    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">📊 Campaign Analysis</Text>
            <Badge tone="info">AI report</Badge>
          </InlineStack>
          {campaignName && (
            <Text as="p" variant="bodySm" tone="subdued">{campaignName}</Text>
          )}
          <MarkdownFallback text={raw} />
        </BlockStack>
      </Card>
    );
  }

  const score = Math.max(0, Math.min(100, Math.round(structured.score ?? 50)));
  const tone = scoreTone(score);
  const strengths = structured.strengths ?? [];
  const weaknesses = structured.weaknesses ?? [];
  const recs = structured.recommendations ?? [];
  const ring = `conic-gradient(${tone.color} ${score * 3.6}deg, #e4e5e7 0deg)`;

  return (
    <Card>
      <BlockStack gap="400">
        {/* Header: title + score ring */}
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">📊 Campaign Analysis</Text>
            {campaignName && (
              <Text as="p" variant="bodySm" tone="subdued">{campaignName}</Text>
            )}
          </BlockStack>
          <InlineStack gap="300" blockAlign="center">
            <Badge tone={tone.tone}>{tone.label}</Badge>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: ring,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: "50%",
                  background: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                {score}
              </div>
            </div>
          </InlineStack>
        </InlineStack>

        {structured.verdict && (
          <Box background="bg-surface-secondary" padding="300" borderRadius="200">
            <Text as="p" variant="bodyMd">
              <Rich text={structured.verdict} />
            </Text>
          </Box>
        )}

        {/* Key metrics */}
        {insights && (
          <Grid columns={{ xs: 2, sm: 3, md: 6 }}>
            <Grid.Cell><Metric label="Spend" value={`$${(insights.spend ?? 0).toFixed(2)}`} /></Grid.Cell>
            <Grid.Cell><Metric label="Impressions" value={fmtInt(insights.impressions)} /></Grid.Cell>
            <Grid.Cell><Metric label="Clicks" value={fmtInt(insights.clicks)} /></Grid.Cell>
            <Grid.Cell><Metric label="CTR" value={`${(insights.ctr ?? 0).toFixed(2)}%`} /></Grid.Cell>
            <Grid.Cell><Metric label="CPC" value={`$${(insights.cpc ?? 0).toFixed(2)}`} /></Grid.Cell>
            <Grid.Cell><Metric label="CPM" value={`$${(insights.cpm ?? 0).toFixed(2)}`} /></Grid.Cell>
          </Grid>
        )}

        {/* Strengths / weaknesses */}
        {(strengths.length > 0 || weaknesses.length > 0) && (
          <Grid columns={{ xs: 1, md: 2 }}>
            {strengths.length > 0 && (
              <Grid.Cell>
                <Box background="bg-surface-success" padding="300" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">✅ What's working</Text>
                    <BlockStack gap="150">
                      {strengths.map((s, i) => (
                        <InlineStack key={i} gap="200" blockAlign="start" wrap={false}>
                          <Text as="span" variant="bodyMd">✓</Text>
                          <Text as="span" variant="bodyMd"><Rich text={s} /></Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Box>
              </Grid.Cell>
            )}
            {weaknesses.length > 0 && (
              <Grid.Cell>
                <Box background="bg-surface-critical" padding="300" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">⚠️ Needs attention</Text>
                    <BlockStack gap="150">
                      {weaknesses.map((w, i) => (
                        <InlineStack key={i} gap="200" blockAlign="start" wrap={false}>
                          <Text as="span" variant="bodyMd">!</Text>
                          <Text as="span" variant="bodyMd"><Rich text={w} /></Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Box>
              </Grid.Cell>
            )}
          </Grid>
        )}

        {/* Recommendations */}
        {recs.length > 0 && (
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">🎯 Recommendations</Text>
            <BlockStack gap="200">
              {recs.map((r, i) => {
                const p = (r.priority ?? "medium").toLowerCase();
                const pTone = p === "high" ? "critical" : p === "low" ? "info" : "warning";
                return (
                  <Box key={i} background="bg-surface" padding="300" borderRadius="200" borderWidth="025" borderColor="border">
                    <BlockStack gap="100">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p" variant="headingSm">
                          {i + 1}. <Rich text={r.title ?? "Recommendation"} />
                        </Text>
                        <Badge tone={pTone}>{p === "high" ? "High priority" : p === "low" ? "Low priority" : "Medium priority"}</Badge>
                      </InlineStack>
                      {r.detail && (
                        <Text as="p" variant="bodyMd" tone="subdued">
                          <Rich text={r.detail} />
                        </Text>
                      )}
                    </BlockStack>
                  </Box>
                );
              })}
            </BlockStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
