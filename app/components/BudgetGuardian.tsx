import { useEffect, useState } from "react";
import {
  BlockStack,
  Button,
  Card,
  InlineStack,
  Text,
  Banner,
  TextField,
  Checkbox,
  Badge,
} from "@shopify/polaris";

interface GuardianSettings {
  enabled: boolean;
  maxSpendNoPurchase: number;
  minRoas: number;
  minSpendForRoas: number;
  notifyOnly: boolean;
  currency: string;
}

interface LogEntry {
  id: string;
  campaignName: string;
  action: string;
  reason: string;
  spend: number;
  purchases: number;
  createdAt: string;
}

/**
 * 🛡️ Budget Guardian — watches every active campaign and auto-pauses
 * money-burners. The core "never lose money" promise.
 */
export default function BudgetGuardian() {
  const [settings, setSettings] = useState<GuardianSettings | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/ads/guardian")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setSettings(d.settings);
          setLog(d.log);
        }
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/ads/guardian", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const d = (await res.json()) as { ok: boolean; message?: string };
      setMsg({ ok: d.ok, text: d.message ?? (d.ok ? "Saved." : "Failed.") });
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server." });
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return null;

  return (
    <div className="ap-enter">
      <Card>
        <BlockStack gap="300">
          <InlineStack gap="200" blockAlign="center" align="space-between">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                🛡️ Budget Guardian
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Watches your campaigns every 30 minutes. Pauses money-burners automatically — you never wake up to wasted spend.
              </Text>
            </BlockStack>
            <Badge tone={settings.enabled ? "success" : undefined}>
              {settings.enabled ? "● Active" : "○ Paused"}
            </Badge>
          </InlineStack>

          {msg && <Banner tone={msg.ok ? "success" : "critical"}>{msg.text}</Banner>}

          <Checkbox
            label="Guardian enabled"
            checked={settings.enabled}
            onChange={(v) => setSettings({ ...settings, enabled: v })}
          />

          <InlineStack gap="300">
            <div style={{ flex: 1 }}>
              <TextField
                label="Kill if $ spent with 0 purchases"
                type="number"
                value={String(settings.maxSpendNoPurchase)}
                onChange={(v) => setSettings({ ...settings, maxSpendNoPurchase: Number(v) || 20 })}
                prefix="$"
                helpText="Pause any campaign that spends this much without a single purchase."
                autoComplete="off"
              />
            </div>
            <div style={{ flex: 1 }}>
              <TextField
                label="Minimum ROAS"
                type="number"
                value={String(settings.minRoas)}
                onChange={(v) => setSettings({ ...settings, minRoas: Number(v) || 1 })}
                helpText="Pause if ROAS drops below this after the spend threshold."
                autoComplete="off"
              />
            </div>
            <div style={{ flex: 1 }}>
              <TextField
                label="Check ROAS after $ spent"
                type="number"
                value={String(settings.minSpendForRoas)}
                onChange={(v) => setSettings({ ...settings, minSpendForRoas: Number(v) || 30 })}
                prefix="$"
                helpText="Only judge ROAS after this much spend (gives Meta time to learn)."
                autoComplete="off"
              />
            </div>
          </InlineStack>

          <Checkbox
            label="Alert only — never auto-pause (I'll pause manually)"
            checked={settings.notifyOnly}
            onChange={(v) => setSettings({ ...settings, notifyOnly: v })}
          />

          <InlineStack>
            <Button variant="primary" loading={saving} onClick={save}>
              Save Guardian settings
            </Button>
          </InlineStack>

          {log.length > 0 && (
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                Recent Guardian actions
              </Text>
              {log.slice(0, 5).map((l) => (
                <InlineStack key={l.id} gap="200" blockAlign="center">
                  <Badge
                    tone={l.action === "paused" ? "critical" : l.action === "scale_suggested" ? "success" : "warning"}
                  >
                    {l.action === "paused" ? "⏸ Paused" : l.action === "scale_suggested" ? "🚀 Scale" : "⚠️ Alert"}
                  </Badge>
                  <Text as="p" variant="bodySm">
                    <strong>{l.campaignName}</strong> — {l.reason}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {new Date(l.createdAt).toLocaleDateString()}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </div>
  );
}
