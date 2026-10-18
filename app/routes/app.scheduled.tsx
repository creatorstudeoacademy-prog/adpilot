import { useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  Grid,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  PHOTO_POST_FEE,
  SCHEDULE_PACKAGES,
  TEXT_POST_FEE,
  VIDEO_POST_FEE,
} from "../lib/pricing";

const STATUS_TONE: Record<string, "info" | "success" | "critical" | undefined> = {
  scheduled: "info",
  published: "success",
  failed: "critical",
  draft: undefined,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [posts, activePackage] = await Promise.all([
    prisma.scheduledPost.findMany({
      where: { shop },
      include: { socialAccount: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.schedulePackage.findFirst({
      where: { shop, status: "active" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return json({
    posts: posts.map((p) => ({
      id: p.id,
      content: p.content.slice(0, 80) + (p.content.length > 80 ? "…" : ""),
      pageName: p.socialAccount.pageName,
      mediaType: p.mediaType,
      platforms: JSON.parse(p.platforms) as string[],
      status: p.status,
      scheduledAt: p.scheduledAt?.toISOString() ?? null,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      error: p.error,
      createdAt: p.createdAt.toISOString(),
    })),
    activePackage: activePackage
      ? {
          label:
            SCHEDULE_PACKAGES.find((s) => s.id === activePackage.packageId)?.label ??
            activePackage.packageId,
          totalPosts: activePackage.totalPosts,
          usedPosts: activePackage.usedPosts,
          endsAt: activePackage.endsAt.toISOString(),
        }
      : null,
    packages: SCHEDULE_PACKAGES,
    fees: {
      text: TEXT_POST_FEE,
      photo: PHOTO_POST_FEE,
      video: VIDEO_POST_FEE,
    },
  });
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function ScheduledPage() {
  const { posts, activePackage, packages, fees } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [buyError, setBuyError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editDate, setEditDate] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const rowAction = async (id: string, act: "update" | "delete") => {
    setRowBusy(id);
    try {
      const res = await fetch("/api/schedule/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          act === "delete"
            ? { id, action: "delete" }
            : { id, action: "update", content: editContent, date: editDate },
        ),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      if (data.ok) {
        setEditingId(null);
        revalidator.revalidate();
      } else {
        setBuyError(data.message || "Couldn't update the post.");
      }
    } catch {
      setBuyError("Couldn't reach the server.");
    } finally {
      setRowBusy(null);
    }
  };

  const rows = posts.map((p) => [
    p.content || "(media only)",
    p.pageName,
    p.mediaType,
    p.platforms.join(", "),
    <Badge key={`s-${p.id}`} tone={STATUS_TONE[p.status]}>
      {p.status}
    </Badge>,
    formatDate(p.scheduledAt ?? p.publishedAt),
    (p.status === "scheduled" || p.status === "draft") ? (
      <InlineStack key={`a-${p.id}`} gap="100">
        <Button
          size="slim"
          variant="plain"
          onClick={() => {
            setEditingId(p.id);
            setEditContent(posts.find((x) => x.id === p.id)?.content ?? "");
            const iso = posts.find((x) => x.id === p.id)?.scheduledAt;
            setEditDate(iso ? iso.slice(0, 10) : "");
          }}
        >
          Edit
        </Button>
        <Button
          size="slim"
          variant="plain"
          tone="critical"
          loading={rowBusy === p.id}
          onClick={() => void rowAction(p.id, "delete")}
        >
          Delete
        </Button>
      </InlineStack>
    ) : (
      <span key={`a-${p.id}`} />
    ),
  ]);

  return (
    <Page
      title="Posts"
      subtitle="Scheduled and published posts"
      primaryAction={{ content: "Compose new", url: "/app/compose" }}
    >
      <BlockStack gap="500">
        {/* ── Active package banner ── */}
        {activePackage && (
          <Banner
            title={`${activePackage.label} active`}
            tone="success"
          >
            <Text as="p" variant="bodyMd">
              {activePackage.usedPosts} of {activePackage.totalPosts} posts used ·
              expires {new Date(activePackage.endsAt).toLocaleDateString()}
            </Text>
          </Banner>
        )}

        {/* ── Auto-schedule packages ── */}
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
              Auto-schedule packages
            </Text>
            <Button url="/app/scheduled/setup" variant="primary">
              Setup auto-schedule
            </Button>
          </InlineStack>
          <Text as="p" variant="bodyMd" tone="subdued">
            One payment covers all your scheduled text posts for the period.
            Manual upload available now — auto-post with photo & video coming soon.
          </Text>
          {buyError && (
            <Banner tone="critical" onDismiss={() => setBuyError(null)}>
              {buyError}
            </Banner>
          )}
          <Grid>
            {packages.map((pkg) => (
              <Grid.Cell
                key={pkg.id}
                columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}
              >
                <Card>
                  <Box padding="400">
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingMd">
                        {pkg.label}
                      </Text>
                      <Text as="p" variant="heading2xl">
                        ${pkg.fee.toFixed(2)}
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        {pkg.posts} scheduled text posts · {pkg.days} days
                      </Text>
                      <Button
                        variant="primary"
                        url={`/app/scheduled/setup`}
                        disabled={!!activePackage}
                      >
                        {activePackage ? "Active package running" : "Select & setup"}
                      </Button>
                    </BlockStack>
                  </Box>
                </Card>
              </Grid.Cell>
            ))}
          </Grid>
          <InlineStack gap="200" blockAlign="center">
            <Badge>Coming soon</Badge>
            <Text as="p" variant="bodySm" tone="subdued">
              Auto-post with photo & auto-post with video
            </Text>
          </InlineStack>
        </BlockStack>

        {/* ── Per-post fees ── */}
        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Pay-per-post (manual upload)
              </Text>
              <InlineStack gap="400">
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Text-only post
                  </Text>
                  <Text as="p" variant="headingMd">
                    ${fees.text.toFixed(2)}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Text + photo
                  </Text>
                  <Text as="p" variant="headingMd">
                    ${fees.photo.toFixed(2)}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Text + video
                  </Text>
                  <Text as="p" variant="headingMd">
                    ${fees.video.toFixed(2)}
                  </Text>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Box>
        </Card>

        {/* ── Posts table ── */}
        {posts.length === 0 ? (
          <Card>
            <EmptyState
              heading="No posts yet"
              action={{ content: "Compose your first post", url: "/app/compose" }}
              image=""
            >
              <Text as="p" variant="bodyMd">
                Write a post and publish it now or schedule it for later.
              </Text>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
              headings={["Content", "Account", "Type", "Platforms", "Status", "Date", "Actions"]}
              rows={rows}
            />
          </Card>
        )}

        {/* ── Edit modal ── */}
        {editingId && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Edit scheduled post
                </Text>
                <TextField
                  label="Date"
                  type="date"
                  value={editDate}
                  onChange={setEditDate}
                  autoComplete="off"
                />
                <TextField
                  label="Content"
                  value={editContent}
                  onChange={setEditContent}
                  multiline={4}
                  autoComplete="off"
                />
                <InlineStack gap="200" align="end">
                  <Button onClick={() => setEditingId(null)}>Cancel</Button>
                  <Button
                    variant="primary"
                    loading={rowBusy === editingId}
                    onClick={() => void rowAction(editingId, "update")}
                  >
                    Save changes
                  </Button>
                </InlineStack>
              </BlockStack>
            </Box>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
