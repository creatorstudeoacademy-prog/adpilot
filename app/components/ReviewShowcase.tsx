import { BlockStack, Box, Card, InlineStack, Text } from "@shopify/polaris";
import { Link } from "@remix-run/react";

import { Anim } from "./ui";

export interface ShowcaseReview {
  author: string;
  rating: number;
  title: string;
  content: string;
}

function Stars({ rating }: { rating: number }) {
  return (
    <Text as="span" variant="bodyMd">
      <span style={{ color: "#f59e0b" }}>{"★".repeat(rating)}</span>
      <span style={{ color: "#d1d5db" }}>{"★".repeat(5 - rating)}</span>
    </Text>
  );
}

/** Compact review showcase — for dashboard / pricing pages. */
export function ReviewShowcase({
  reviews,
  animIndex = 4,
}: {
  reviews: ShowcaseReview[];
  animIndex?: number;
}) {
  if (reviews.length === 0) return null;

  const avg = (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1);

  return (
    <Anim index={animIndex}>
      <Card>
        <Box padding="400">
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                ⭐ Loved by merchants
              </Text>
              <Link to="/app/reviews" style={{ textDecoration: "none" }}>
                <Text as="span" variant="bodyMd" tone="subdued">
                  {avg} ★ · {reviews.length} reviews →
                </Text>
              </Link>
            </InlineStack>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "12px",
              }}
            >
              {reviews.slice(0, 3).map((r, i) => (
                <div key={i} className="ap-card-hover">
                  <Box
                    background="bg-surface-secondary"
                    borderRadius="200"
                    padding="300"
                  >
                    <BlockStack gap="150">
                      <Stars rating={r.rating} />
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {r.title}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        "{r.content.slice(0, 100)}{r.content.length > 100 ? "…" : ""}"
                      </Text>
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        — {r.author}
                      </Text>
                    </BlockStack>
                  </Box>
                </div>
              ))}
            </div>
          </BlockStack>
        </Box>
      </Card>
    </Anim>
  );
}
