import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Grid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Anim, Hero } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const reviews = await prisma.review.findMany({
    where: { approved: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return json({
    reviews: reviews.map((r) => ({
      id: r.id,
      author: r.author,
      rating: r.rating,
      title: r.title,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    })),
  });
};

function Stars({ rating }: { rating: number }) {
  return (
    <Text as="span" variant="bodyMd">
      {"★".repeat(rating)}
      <span style={{ color: "#d1d5db" }}>{"★".repeat(5 - rating)}</span>
    </Text>
  );
}

export default function ReviewsPage() {
  const { reviews } = useLoaderData<typeof loader>();
  const [author, setAuthor] = useState("");
  const [rating, setRating] = useState("5");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submitReview = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author, rating: Number(rating), title, content }),
      });
      const data = await res.json();
      if (data.ok) {
        setMsg({ ok: true, text: data.message });
        setAuthor("");
        setTitle("");
        setContent("");
      } else {
        setMsg({ ok: false, text: data.error || "Couldn't submit." });
      }
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  };

  const avg =
    reviews.length > 0
      ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
      : "—";

  return (
    <Page title="Reviews" subtitle="What merchants say about AdPilot">
      <BlockStack gap="500">
        <Anim index={0}>
          <Hero
            title="⭐ Merchant Reviews"
            subtitle={`${reviews.length} reviews · ${avg} average rating`}
          />
        </Anim>

        {reviews.length > 0 ? (
          <Grid>
            {reviews.map((r, i) => (
              <Grid.Cell key={r.id} columnSpan={{ xs: 6, sm: 3, md: 4, lg: 4, xl: 4 }}>
                <Anim index={i % 5}>
                  <div className="ap-card-hover" style={{ height: "100%" }}>
                    <Card>
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Stars rating={r.rating} />
                          <Badge>{new Date(r.createdAt).toLocaleDateString()}</Badge>
                        </InlineStack>
                        <Text as="p" variant="headingSm">
                          {r.title}
                        </Text>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          "{r.content}"
                        </Text>
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          — {r.author}
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                </Anim>
              </Grid.Cell>
            ))}
          </Grid>
        ) : (
          <Anim index={1}>
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingMd" alignment="center">
                  No reviews yet — be the first!
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                  Share your experience below and help other merchants.
                </Text>
              </BlockStack>
            </Card>
          </Anim>
        )}

        <Anim index={2}>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                ✍️ Write a review
              </Text>
              {msg && (
                <Banner tone={msg.ok ? "success" : "critical"}>{msg.text}</Banner>
              )}
              <Grid>
                <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 6, lg: 6, xl: 6 }}>
                  <TextField
                    label="Your name"
                    value={author}
                    onChange={setAuthor}
                    autoComplete="off"
                    placeholder="e.g. Sarah from TrendyShop"
                  />
                </Grid.Cell>
                <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 6, lg: 6, xl: 6 }}>
                  <Select
                    label="Rating"
                    options={[
                      { label: "★★★★★ — Excellent", value: "5" },
                      { label: "★★★★ — Good", value: "4" },
                      { label: "★★★ — Okay", value: "3" },
                      { label: "★★ — Poor", value: "2" },
                      { label: "★ — Bad", value: "1" },
                    ]}
                    value={rating}
                    onChange={setRating}
                  />
                </Grid.Cell>
              </Grid>
              <TextField
                label="Headline"
                value={title}
                onChange={setTitle}
                autoComplete="off"
                placeholder="e.g. Saved me hours every week!"
              />
              <TextField
                label="Your review"
                value={content}
                onChange={setContent}
                multiline={4}
                autoComplete="off"
                placeholder="Tell other merchants what you love about AdPilot..."
              />
              <Button variant="primary" loading={busy} onClick={() => void submitReview()}>
                Submit review
              </Button>
            </BlockStack>
          </Card>
        </Anim>
      </BlockStack>
    </Page>
  );
}
