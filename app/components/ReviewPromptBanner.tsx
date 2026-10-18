import { useEffect, useState } from "react";
import { Banner, Button, InlineStack } from "@shopify/polaris";

/**
 * Shows a review prompt banner at success moments (first campaign,
 * winning campaign, 30 days). Dismissible.
 */
export default function ReviewPromptBanner() {
  const [prompt, setPrompt] = useState<{ trigger: string; title: string; message: string } | null>(null);

  useEffect(() => {
    fetch("/api/review-prompt")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.prompt) setPrompt(d.prompt);
      })
      .catch(() => {});
  }, []);

  const dismiss = async () => {
    if (!prompt) return;
    setPrompt(null);
    try {
      await fetch("/api/review-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: prompt.trigger }),
      });
    } catch {
      /* ignore */
    }
  };

  if (!prompt) return null;

  return (
    <Banner tone="success" onDismiss={dismiss}>
      <InlineStack gap="200" blockAlign="center" align="space-between">
        <div>
          <strong>{prompt.title}</strong>
          <br />
          {prompt.message}
        </div>
        <Button url="/app/reviews" variant="primary" size="slim">
          Write a review
        </Button>
      </InlineStack>
    </Banner>
  );
}
