import { BlockStack, Box, InlineStack, Text } from "@shopify/polaris";
import { Link } from "@remix-run/react";
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
      <div
        className="ap-anim-up"
        style={{
          background: "linear-gradient(135deg, #1e1b4b 0%, #4c1d95 50%, #7c3aed 100%)",
          borderRadius: "16px",
          color: "#fff",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 85% 15%, rgba(255,255,255,0.15), transparent 50%)",
            pointerEvents: "none",
          }}
        />
        <Box padding="600">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start">
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: "12px",
                      background: "rgba(255,255,255,0.2)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "20px",
                    }}
                  >
                    ✈️
                  </div>
                  <Text as="p" variant="headingLg">
                    <span style={{ color: "#fff" }}>AdPilot</span>
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodyMd">
                  <span style={{ color: "rgba(255,255,255,0.75)" }}>
                    Social media command center — schedule posts,
                    <br />
                    run Meta ads, all from one place.
                  </span>
                </Text>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  <span style={{ color: "#fff" }}>Product</span>
                </Text>
                {[
                  ["Compose", "/app/compose"],
                  ["Scheduled", "/app/scheduled"],
                  ["Ads Manager", "/app/ads"],
                  ["Full Funnel", "/app/ads/funnel"],
                ].map(([label, href]) => (
                  <Text key={href} as="p" variant="bodySm">
                    <Link to={href} style={{ color: "rgba(255,255,255,0.7)", textDecoration: "none" }}>
                      {label}
                    </Link>
                  </Text>
                ))}
              </BlockStack>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  <span style={{ color: "#fff" }}>Account</span>
                </Text>
                {[
                  ["Wallet", "/app/wallet"],
                  ["Pricing", "/app/billing"],
                  ["Accounts", "/app/accounts"],
                ].map(([label, href]) => (
                  <Text key={href} as="p" variant="bodySm">
                    <Link to={href} style={{ color: "rgba(255,255,255,0.7)", textDecoration: "none" }}>
                      {label}
                    </Link>
                  </Text>
                ))}
              </BlockStack>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  <span style={{ color: "#fff" }}>Support</span>
                </Text>
                {[
                  ["Support Chat", "/app/support"],
                  ["Reviews", "/app/reviews"],
                ].map(([label, href]) => (
                  <Text key={href} as="p" variant="bodySm">
                    <Link to={href} style={{ color: "rgba(255,255,255,0.7)", textDecoration: "none" }}>
                      {label}
                    </Link>
                  </Text>
                ))}
              </BlockStack>
            </InlineStack>
            <div
              style={{
                borderTop: "1px solid rgba(255,255,255,0.2)",
                paddingTop: "16px",
              }}
            >
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodySm">
                  <span style={{ color: "rgba(255,255,255,0.6)" }}>
                    © 2026 AdPilot by Creator Studio. All rights reserved.
                  </span>
                </Text>
                <InlineStack gap="300">
                  <Text as="p" variant="bodySm">
                    <Link to="/privacy" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>
                      Privacy
                    </Link>
                  </Text>
                  <Text as="p" variant="bodySm">
                    <Link to="/terms" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>
                      Terms
                    </Link>
                  </Text>
                </InlineStack>
              </InlineStack>
            </div>
          </BlockStack>
        </Box>
      </div>
    </div>
  );
}
