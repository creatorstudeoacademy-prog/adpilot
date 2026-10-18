import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

interface LiveEvent {
  id: string;
  eventName: string;
  source: string;
  url?: string | null;
  value?: number | null;
  currency?: string | null;
  createdAt: string;
}

interface FilterSettings {
  dedupeEnabled: boolean;
  botFilterEnabled: boolean;
  piiScrubEnabled: boolean;
  staffFilterEnabled: boolean;
  staffIps: string;
  requireValueCurrency: boolean;
  pixelId?: string | null;
}

const EVENT_ICON: Record<string, string> = {
  PageView: "👁️",
  ViewContent: "🛍️",
  AddToCart: "🛒",
  InitiateCheckout: "💳",
  AddPaymentInfo: "💳",
  Purchase: "✅",
  Lead: "📝",
};

const SOURCE_TONE: Record<string, "info" | "success" | "warning"> = {
  browser: "info",
  server: "success",
  test: "warning",
};

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * Pixel Live Hub: shows the live data pipe (Shop -> AdPilot -> Meta),
 * a live animated event feed (like Events Manager), and the pure-data
 * filters that keep pixel signal clean for better optimization.
 */
export default function PixelLiveSection({ pixelId }: { pixelId: string }) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<FilterSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const lastSeen = useRef<string>("");
  const [tick, setTick] = useState(0); // re-render time-ago labels

  const loadFeed = useCallback(
    async (initial = false) => {
      try {
        const params = new URLSearchParams({ pixelId });
        if (!initial && lastSeen.current) params.set("since", lastSeen.current);
        const res = await fetch(`/api/pixel/live-feed?${params}`);
        const data = (await res.json()) as { ok: boolean; events?: LiveEvent[] };
        if (!data.ok || !data.events) return;
        if (initial) {
          setEvents(data.events);
          if (data.events[0]) lastSeen.current = data.events[0].createdAt;
        } else if (data.events.length > 0) {
          // API returns newest-first; prepend chronologically for the feed.
          const fresh = [...data.events].reverse();
          setEvents((prev) => [...fresh, ...prev].slice(0, 50));
          lastSeen.current = data.events[0].createdAt;
        }
      } catch {
        // feed keeps showing last known events
      } finally {
        if (initial) setLoading(false);
      }
    },
    [pixelId],
  );

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/pixel/settings");
      const data = (await res.json()) as { ok: boolean; settings?: FilterSettings };
      if (data.ok && data.settings) setSettings(data.settings);
    } catch {
      // filters stay hidden until load succeeds
    }
  }, []);

  useEffect(() => {
    setEvents([]);
    lastSeen.current = "";
    setLoading(true);
    void loadFeed(true);
    void loadSettings();
  }, [pixelId, loadFeed, loadSettings]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void loadFeed(false), 5000);
    return () => clearInterval(id);
  }, [live, loadFeed]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const saveSettings = async (patch: Partial<FilterSettings>) => {
    const next = { ...(settings ?? {}), ...patch } as FilterSettings;
    setSettings(next);
    setSaving(true);
    try {
      await fetch("/api/pixel/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, pixelId }),
      });
    } finally {
      setSaving(false);
    }
  };

  const lastEvent = events[0];
  const pulse = live && lastEvent && Date.now() - new Date(lastEvent.createdAt).getTime() < 60000;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingSm">
            📡 Pixel Live Hub
          </Text>
          <div style={{ marginLeft: "auto" }}>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={pulse ? "success" : "info"}>
                {pulse ? "● LIVE" : live ? "○ Listening" : "⏸ Paused"}
              </Badge>
              <Button size="slim" variant="plain" onClick={() => setLive((v) => !v)}>
                {live ? "Pause" : "Resume"}
              </Button>
            </InlineStack>
          </div>
        </InlineStack>

        {/* The live data pipe: Shop -> AdPilot -> Meta */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderRadius: 12,
            background: "linear-gradient(90deg, #f4f0ff 0%, #eef7ff 50%, #f0fff4 100%)",
          }}
        >
          <Badge>🏪 Your store</Badge>
          <span style={{ flex: 1, textAlign: "center", color: pulse ? "#108043" : "#8c9196" }}>
            {pulse ? "━ ● ━━━━ ● ━━━━ ▶" : "━━━━━━━━━━ ▶"}
          </span>
          <Badge tone="info">AdPilot filters</Badge>
          <span style={{ flex: 1, textAlign: "center", color: pulse ? "#108043" : "#8c9196" }}>
            {pulse ? "━ ● ━━━━ ● ━━━━ ▶" : "━━━━━━━━━━ ▶"}
          </span>
          <Badge tone="success">Meta ✓</Badge>
        </div>
        <Text as="p" variant="bodySm" tone="subdued">
          {lastEvent
            ? `Last event: ${lastEvent.eventName} ${timeAgo(lastEvent.createdAt)}${tick >= 0 ? "" : ""}`
            : "No events yet — send a test event above or install the web pixel on your store."}
        </Text>

        {/* Animated live feed */}
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" fontWeight="semibold">
            Live event stream
          </Text>
          {loading && (
            <Text as="p" variant="bodySm" tone="subdued">
              Connecting…
            </Text>
          )}
          {!loading && events.length === 0 && (
            <Text as="p" variant="bodySm" tone="subdued">
              Nothing yet. Events from your store, server and tests will appear
              here live, newest first.
            </Text>
          )}
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            <BlockStack gap="100">
              {events.map((e, i) => (
                <div
                  key={e.id}
                  className={i === 0 && pulse ? "ap-live-event-new" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: i === 0 ? "#f6fff9" : "#fafafa",
                    border: i === 0 ? "1px solid #bbe5b3" : "1px solid #eee",
                    animation: i === 0 && pulse ? "ap-live-in 0.5s ease-out" : undefined,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{EVENT_ICON[e.eventName] ?? "📊"}</span>
                  <BlockStack gap="050">
                    <InlineStack gap="100" blockAlign="center">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        {e.eventName}
                      </Text>
                      <Badge tone={SOURCE_TONE[e.source] ?? "info"}>{e.source}</Badge>
                      {e.value != null && (
                        <Text as="p" variant="bodySm">
                          {e.value} {e.currency ?? ""}
                        </Text>
                      )}
                    </InlineStack>
                    {e.url && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {e.url.length > 60 ? e.url.slice(0, 60) + "…" : e.url}
                      </Text>
                    )}
                  </BlockStack>
                  <div style={{ marginLeft: "auto" }}>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {timeAgo(e.createdAt)}
                    </Text>
                  </div>
                </div>
              ))}
            </BlockStack>
          </div>
        </BlockStack>

        {/* Pure-data filters */}
        {settings && (
          <BlockStack gap="150">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              🧹 Pure-data filters{" "}
              <Text as="span" variant="bodySm" tone="subdued">
                — clean signal, better optimization
              </Text>
            </Text>
            <Checkbox
              label="Remove duplicate events (browser + server double-fire)"
              checked={settings.dedupeEnabled}
              onChange={(v) => void saveSettings({ dedupeEnabled: v })}
            />
            <Checkbox
              label="Block bot & crawler traffic"
              checked={settings.botFilterEnabled}
              onChange={(v) => void saveSettings({ botFilterEnabled: v })}
            />
            <Checkbox
              label="Scrub personal data from URLs (emails, phone numbers)"
              checked={settings.piiScrubEnabled}
              onChange={(v) => void saveSettings({ piiScrubEnabled: v })}
            />
            <Checkbox
              label="Require value + currency on purchase events"
              helpText="Events without value make ROAS reporting useless — drop them."
              checked={settings.requireValueCurrency}
              onChange={(v) => void saveSettings({ requireValueCurrency: v })}
            />
            <Checkbox
              label="Exclude staff traffic by IP"
              checked={settings.staffFilterEnabled}
              onChange={(v) => void saveSettings({ staffFilterEnabled: v })}
            />
            {settings.staffFilterEnabled && (
              <TextField
                label="Staff IPs (comma-separated)"
                value={settings.staffIps}
                onChange={(v) => void saveSettings({ staffIps: v })}
                placeholder="e.g. 103.4.5.6, 103.4.5.7"
                autoComplete="off"
              />
            )}
            {saving && (
              <Text as="p" variant="bodySm" tone="subdued">
                Saving…
              </Text>
            )}
          </BlockStack>
        )}
      </BlockStack>
      <style>{`
        @keyframes ap-live-in {
          0% { transform: translateY(-8px); opacity: 0; background: #d8f3dc; }
          100% { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </Card>
  );
}
