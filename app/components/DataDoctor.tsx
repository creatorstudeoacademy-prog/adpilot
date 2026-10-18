import { useState } from "react";
import { BlockStack, Button, Card, InlineStack, Text, Banner, Select, Badge } from "@shopify/polaris";

interface DoctorIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  fixLabel?: string;
  fixAction?: string;
  steps?: string[];
}

interface Diagnosis {
  orderStats: { total: number; revenue: number; currency: string; testOrders: number; zeroValue: number; unpaid: number };
  pixel: { id: string | null; name?: string; lastFired?: string | null };
  pixelsAvailable: Array<{ id: string; name: string }>;
  issues: DoctorIssue[];
  fixFee: number;
}

/**
 * Pixel & Data Doctor: diagnoses pixel + order-data health from one place
 * and applies one-click fixes (paid). Also does inline pixel setup.
 */
export default function DataDoctor() {
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [setupPixel, setSetupPixel] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setDiag(null);
    try {
      const res = await fetch("/api/ads/data-doctor");
      const data = (await res.json()) as { ok: boolean; message?: string } & Diagnosis;
      if (!data.ok) throw new Error(data.message ?? "Diagnosis failed.");
      setDiag(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Diagnosis failed.");
    } finally {
      setBusy(false);
    }
  };

  const applyFix = async (fixAction: string, extra?: Record<string, string>) => {
    setFixing(fixAction);
    setError(null);
    setResult(null);
    try {
      const body = new URLSearchParams({ intent: "fix", fixAction, ...(extra ?? {}) });
      const res = await fetch("/api/ads/data-doctor", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      if (!data.ok) throw new Error(data.message ?? "Fix failed.");
      setResult(data.message ?? "Fixed.");
      await run(); // refresh diagnosis
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fix failed.");
    } finally {
      setFixing(null);
    }
  };

  const toneFor = (s: string) => (s === "critical" ? "critical" : s === "warning" ? "warning" : "info");

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center" align="space-between">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">
              🔧 Pixel & Data Doctor
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Real Shopify orders vs ad data, pixel health, and one-click fixes — everything from here.
            </Text>
          </BlockStack>
          <Button variant="primary" onClick={run} loading={busy}>
            {diag ? "Re-run diagnosis" : "Run diagnosis"}
          </Button>
        </InlineStack>

        {error && <Banner tone="critical">{error}</Banner>}
        {result && <Banner tone="success">{result}</Banner>}

        {diag && (
          <BlockStack gap="300">
            {/* Real order data */}
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  🛍️ Real order data (last 30 days, from your store)
                </Text>
                <InlineStack gap="400">
                  <BlockStack gap="050">
                    <Text as="p" variant="headingMd">
                      {diag.orderStats.total}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      real orders
                    </Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text as="p" variant="headingMd">
                      {diag.orderStats.currency} {diag.orderStats.revenue.toFixed(2)}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      revenue
                    </Text>
                  </BlockStack>
                  {diag.orderStats.testOrders > 0 && (
                    <BlockStack gap="050">
                      <Text as="p" variant="headingMd">
                        <span style={{ color: "#bf0711" }}>{diag.orderStats.testOrders}</span>
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        test/fake orders
                      </Text>
                    </BlockStack>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Strategy reports are built on these real orders — not inflated ad numbers.
                </Text>
              </BlockStack>
            </Card>

            {/* Pixel status */}
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center" align="space-between">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    📡 Pixel status
                  </Text>
                  {diag.pixel.id ? (
                    <Badge tone="success">Connected: {diag.pixel.id}</Badge>
                  ) : (
                    <Badge tone="critical">Not connected</Badge>
                  )}
                </InlineStack>
                {diag.pixel.id && diag.pixel.lastFired && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Last fired: {new Date(diag.pixel.lastFired).toLocaleString()}
                    {diag.pixel.name ? ` · ${diag.pixel.name}` : ""}
                  </Text>
                )}
                {/* Inline pixel setup */}
                {!diag.pixel.id && diag.pixelsAvailable.length > 0 && (
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <Select
                        label="Choose a pixel to connect"
                        options={[
                          { label: "Select a pixel…", value: "" },
                          ...diag.pixelsAvailable.map((p) => ({ label: `${p.name} (${p.id})`, value: p.id })),
                        ]}
                        value={setupPixel}
                        onChange={setSetupPixel}
                      />
                    </div>
                    <Button
                      variant="primary"
                      disabled={!setupPixel}
                      loading={fixing === "setup_pixel"}
                      onClick={() => applyFix("setup_pixel", { pixelId: setupPixel })}
                    >
                      Connect pixel
                    </Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            {/* Issues */}
            {diag.issues.length === 0 ? (
              <Banner tone="success">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  ✅ All healthy — no issues found.
                </Text>
                <Text as="p" variant="bodySm">
                  Pixel is firing, filters are on, and your order data is clean.
                </Text>
              </Banner>
            ) : (
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Found {diag.issues.length} issue{diag.issues.length === 1 ? "" : "s"}:
                </Text>
                {diag.issues.map((issue) => (
                  <Card key={issue.id}>
                    <BlockStack gap="200">
                      <InlineStack gap="200" blockAlign="center" align="space-between">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={toneFor(issue.severity)}>
                            {issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵"}{" "}
                            {issue.severity}
                          </Badge>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            {issue.title}
                          </Text>
                        </InlineStack>
                        {issue.fixAction && issue.fixLabel && (
                          <Button
                            variant="primary"
                            size="slim"
                            loading={fixing === issue.fixAction}
                            onClick={() => applyFix(issue.fixAction!)}
                          >
                            {issue.fixLabel}
                          </Button>
                        )}
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {issue.detail}
                      </Text>
                      {issue.steps && issue.steps.length > 0 && (
                        <div>
                          <Button
                            variant="plain"
                            onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}
                          >
                            {expanded === issue.id ? "Hide steps ▲" : "Show fix steps ▼"}
                          </Button>
                          {expanded === issue.id && (
                            <BlockStack gap="100">
                              {issue.steps.map((st, i) => (
                                <Text key={i} as="p" variant="bodySm">
                                  {i + 1}. {st}
                                </Text>
                              ))}
                            </BlockStack>
                          )}
                        </div>
                      )}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
