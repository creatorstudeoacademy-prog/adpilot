import { BlockStack, Box, InlineStack, Text } from "@shopify/polaris";
import type { ReactNode } from "react";

/** Animated gradient hero banner. */
export function Hero({
  title,
  subtitle,
  children,
  animClass = "ap-anim-up",
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  animClass?: string;
}) {
  return (
    <div className={`ap-hero ${animClass}`}>
      <Box padding="600">
        <BlockStack gap="300">
          <Text as="h1" variant="heading2xl">
            <span style={{ color: "#fff" }}>{title}</span>
          </Text>
          {subtitle && (
            <Text as="p" variant="bodyLg">
              <span style={{ color: "rgba(255,255,255,0.9)" }}>{subtitle}</span>
            </Text>
          )}
          {children}
        </BlockStack>
      </Box>
    </div>
  );
}

/** Promotional banner (coupon/promo announcements). */
export function PromoBanner({
  icon = "🎟️",
  title,
  description,
  animClass = "ap-anim-up ap-anim-2",
}: {
  icon?: string;
  title: string;
  description: string;
  animClass?: string;
}) {
  return (
    <div className={`ap-promo-banner ${animClass}`}>
      <Box padding="400">
        <InlineStack gap="300" blockAlign="center">
          <Text as="span" variant="headingXl">
            {icon}
          </Text>
          <BlockStack gap="100">
            <Text as="p" variant="headingMd">
              {title}
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              {description}
            </Text>
          </BlockStack>
        </InlineStack>
      </Box>
    </div>
  );
}

/** Staggered animation wrapper — pass index 0-4 for cascade effect. */
export function Anim({
  index = 0,
  children,
}: {
  index?: number;
  children: ReactNode;
}) {
  const cls = ["ap-anim-up", "ap-anim-1", "ap-anim-2", "ap-anim-3", "ap-anim-4", "ap-anim-5"][
    Math.min(index + 1, 5)
  ];
  return <div className={cls}>{children}</div>;
}

/** App footer — shown on all pages. */
export function Footer() {
  return (
    <div style={{ marginTop: "48px" }}>
      <Box
        background="bg-surface-secondary"
        borderRadius="300"
        padding="500"
      >
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <div
                  style={{
                    width: "36px",
                    height: "36px",
                    borderRadius: "10px",
                    background: "linear-gradient(135deg, #5c6ac4, #8b5cf6)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "18px",
                  }}
                >
                  ✈️
                </div>
                <Text as="p" variant="headingMd">
                  AdPilot
                </Text>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Social media command center — schedule posts,
                <br />
                run Meta ads, all from one place.
              </Text>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Product
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/compose" style={{ color: "inherit", textDecoration: "none" }}>Compose</a>
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/scheduled" style={{ color: "inherit", textDecoration: "none" }}>Scheduled</a>
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/ads" style={{ color: "inherit", textDecoration: "none" }}>Ads Manager</a>
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/ads/funnel" style={{ color: "inherit", textDecoration: "none" }}>Full Funnel</a>
              </Text>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Account
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/wallet" style={{ color: "inherit", textDecoration: "none" }}>Wallet</a>
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/billing" style={{ color: "inherit", textDecoration: "none" }}>Pricing</a>
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/accounts" style={{ color: "inherit", textDecoration: "none" }}>Accounts</a>
              </Text>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Support
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/support" style={{ color: "inherit", textDecoration: "none" }}>Support Chat</a>
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <a href="/app/reviews" style={{ color: "inherit", textDecoration: "none" }}>Reviews</a>
              </Text>
            </BlockStack>
          </InlineStack>
          <div
            style={{
              borderTop: "1px solid #e1e3e5",
              paddingTop: "16px",
            }}
          >
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                © 2026 AdPilot by Creator Studio. All rights reserved.
              </Text>
              <InlineStack gap="300">
                <Text as="p" variant="bodySm" tone="subdued">
                  <a href="/privacy" style={{ color: "inherit", textDecoration: "none" }}>Privacy</a>
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  <a href="/terms" style={{ color: "inherit", textDecoration: "none" }}>Terms</a>
                </Text>
              </InlineStack>
            </InlineStack>
          </div>
        </BlockStack>
      </Box>
    </div>
  );
}
