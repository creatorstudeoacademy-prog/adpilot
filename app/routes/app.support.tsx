import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { Anim, Hero } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const WELCOME: Msg = {
  role: "assistant",
  content:
    "Hi! I'm the AdPilot support assistant. Ask me anything about connecting accounts, publishing posts, running ads, audiences, wallet top-ups, or pricing — I'm here to help.",
};

export default function SupportChat() {
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const res = await fetch("/api/support/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: next.filter((m) => m !== WELCOME),
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        reply?: string;
        message?: string;
      };
      if (data.ok && data.reply) {
        setMessages([...next, { role: "assistant", content: data.reply }]);
      } else {
        setError(data.message || "Something went wrong. Please try again.");
      }
    } catch {
      setError("Couldn't reach the support assistant. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Page title="Support Chat" subtitle="Ask anything about AdPilot — free, powered by AI">
      <BlockStack gap="400">
        <Anim index={0}>
          <Hero
            title="Support Chat"
            subtitle="Ask anything about AdPilot — free, replies instantly"
          />
        </Anim>
        <Anim index={1}>
        <div className="ap-card-hover">
        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Box
                minHeight="320px"
                maxHeight="480px"
                overflowY="auto"
                padding="200"
              >
                <BlockStack gap="300">
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent:
                          m.role === "user" ? "flex-end" : "flex-start",
                      }}
                    >
                      <Box
                        background={
                          m.role === "user" ? "bg-fill-brand" : "bg-surface-secondary"
                        }
                        borderRadius="200"
                        padding="300"
                        maxWidth="80%"
                      >
                        <Text
                          as="p"
                          variant="bodyMd"
                          tone={m.role === "user" ? undefined : undefined}
                        >
                          <span
                            style={
                              m.role === "user" ? { color: "#fff" } : undefined
                            }
                          >
                            {m.content}
                          </span>
                        </Text>
                      </Box>
                    </div>
                  ))}
                  {sending && (
                    <div style={{ display: "flex", justifyContent: "flex-start" }}>
                      <Box
                        background="bg-surface-secondary"
                        borderRadius="200"
                        padding="300"
                      >
                        <Text as="p" variant="bodyMd" tone="subdued">
                          Typing…
                        </Text>
                      </Box>
                    </div>
                  )}
                  <div ref={bottomRef} />
                </BlockStack>
              </Box>
              {error && (
                <Text as="p" variant="bodyMd" tone="critical">
                  {error}
                </Text>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Message"
                      labelHidden
                      value={input}
                      onChange={setInput}
                      placeholder="e.g. How do I connect my Facebook Page?"
                      autoComplete="off"
                      disabled={sending}
                    />
                  </div>
                  <Button
                    variant="primary"
                    submit
                    loading={sending}
                    disabled={!input.trim()}
                  >
                    Send
                  </Button>
                </InlineStack>
              </form>
              <Text as="p" variant="bodySm" tone="subdued">
                For account-specific help: support@creatorstudioacademy.com
              </Text>
            </BlockStack>
          </Box>
        </Card>
        </div>
        </Anim>
      </BlockStack>
    </Page>
  );
}
