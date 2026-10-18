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
