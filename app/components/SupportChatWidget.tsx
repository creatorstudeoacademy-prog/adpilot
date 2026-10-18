import { useEffect, useRef, useState } from "react";
import { Box, Button, Icon, Text, TextField } from "@shopify/polaris";
import { ChatIcon, XIcon } from "@shopify/polaris-icons";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const WELCOME: Msg = {
  role: "assistant",
  content: "Hi! I'm the AdPilot support assistant. How can I help you today?",
};

/**
 * Floating support-chat widget — renders on every app page (bottom-right).
 * Professional popup panel, powered by /api/support/chat (free).
 */
export function SupportChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUnread, setHasUnread] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, open]);

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
        if (!open) setHasUnread(true);
      } else {
        setError(data.message || "Something went wrong. Please try again.");
      }
    } catch {
      setError("Couldn't reach the support assistant. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const toggle = () => {
    setOpen((o) => !o);
    setHasUnread(false);
  };

  return (
    <>
      {/* Popup panel */}
      {open && (
        <div
          style={{
            position: "fixed",
            bottom: "88px",
            right: "24px",
            width: "380px",
            maxWidth: "calc(100vw - 48px)",
            height: "520px",
            maxHeight: "calc(100vh - 140px)",
            background: "#fff",
            borderRadius: "12px",
            boxShadow:
              "0 12px 48px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 9999,
          }}
        >
          {/* Header */}
          <div
            style={{
              background: "linear-gradient(135deg, #5c6ac4 0%, #3f4a9e 100%)",
              padding: "14px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                }}
              >
                <Icon source={ChatIcon as never} tone="base" />
              </div>
              <div>
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  <span style={{ color: "#fff" }}>AdPilot Support</span>
                </Text>
                <Text as="p" variant="bodySm">
                  <span style={{ color: "rgba(255,255,255,0.8)" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: "7px",
                        height: "7px",
                        borderRadius: "50%",
                        background: "#4ade80",
                        marginRight: "5px",
                      }}
                    />
                    Online — replies instantly
                  </span>
                </Text>
              </div>
            </div>
            <button
              onClick={toggle}
              aria-label="Close chat"
              style={{
                background: "transparent",
                border: "none",
                color: "#fff",
                cursor: "pointer",
                padding: "4px",
              }}
            >
              <Icon source={XIcon as never} tone="base" />
            </button>
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              background: "#f6f6f7",
            }}
          >
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    background: m.role === "user" ? "#5c6ac4" : "#fff",
                    color: m.role === "user" ? "#fff" : "#202223",
                    borderRadius: "14px",
                    borderTopRightRadius: m.role === "user" ? "4px" : "14px",
                    borderTopLeftRadius: m.role === "assistant" ? "4px" : "14px",
                    padding: "9px 13px",
                    maxWidth: "82%",
                    fontSize: "13.5px",
                    lineHeight: "1.45",
                    boxShadow:
                      m.role === "assistant"
                        ? "0 1px 3px rgba(0,0,0,0.08)"
                        : "none",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div
                  style={{
                    background: "#fff",
                    borderRadius: "14px",
                    borderTopLeftRadius: "4px",
                    padding: "9px 13px",
                    fontSize: "13.5px",
                    color: "#6d7175",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                  }}
                >
                  Typing…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding: "10px 12px",
              borderTop: "1px solid #e1e3e5",
              background: "#fff",
            }}
          >
            {error && (
              <div style={{ marginBottom: "6px" }}>
                <Text as="p" variant="bodySm" tone="critical">
                  {error}
                </Text>
              </div>
            )}
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Message"
                  labelHidden
                  value={input}
                  onChange={setInput}
                  placeholder="Type your message…"
                  autoComplete="off"
                  disabled={sending}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </div>
              <Button
                variant="primary"
                onClick={() => void send()}
                loading={sending}
                disabled={!input.trim()}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Floating button */}
      <button
        onClick={toggle}
        aria-label={open ? "Close support chat" : "Open support chat"}
        style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          background: "linear-gradient(135deg, #5c6ac4 0%, #3f4a9e 100%)",
          border: "none",
          boxShadow: "0 6px 20px rgba(92,106,196,0.45)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          zIndex: 9999,
          transition: "transform 0.15s ease",
        }}
        onMouseOver={(e) => (e.currentTarget.style.transform = "scale(1.06)")}
        onMouseOut={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        <Icon source={(open ? XIcon : ChatIcon) as never} tone="base" />
        {hasUnread && !open && (
          <span
            style={{
              position: "absolute",
              top: "2px",
              right: "2px",
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              background: "#d72c0d",
              border: "2px solid #fff",
            }}
          />
        )}
      </button>
    </>
  );
}
