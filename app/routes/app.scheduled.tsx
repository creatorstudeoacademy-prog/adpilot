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
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import { Anim, Hero, PromoBanner } from "../components/ui";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  LIFETIME_MAX_POSTS_PER_DAY,
  LIFETIME_PACKS,
  PHOTO_POST_FEE,
  SCHEDULE_PACKAGES,
  TEXT_POST_FEE,
  VIDEO_POST_FEE,
  lifetimeFee,
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

  const [posts, activePackage, allPackages, lifetime, socialAccounts] = await Promise.all([
    prisma.scheduledPost.findMany({
      where: { shop },
      include: { socialAccount: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.schedulePackage.findFirst({
      where: { shop, status: "active" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.schedulePackage.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.lifetimePackage.findFirst({
      where: { shop, status: "active" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.socialAccount.findMany({
      where: { shop },
      select: { id: true, pageName: true, platform: true },
    }),
  ]);

  const pkgLabel = (id: string) =>
    SCHEDULE_PACKAGES.find((s) => s.id === id)?.label ?? id;

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
      packageId: (p as { schedulePackageId?: string | null }).schedulePackageId ?? null,
    })),
    boughtPackages: allPackages.map((pk) => ({
      id: pk.id,
      label: `${pkgLabel(pk.packageId)} · ${new Date(pk.createdAt).toLocaleDateString()}`,
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
    lifetime: lifetime
      ? {
          postsPerDay: lifetime.postsPerDay,
          autoRenew: lifetime.autoRenew,
          endsAt: lifetime.endsAt.toISOString(),
        }
      : null,
    lifetimePacks: LIFETIME_PACKS.map((p) => ({
      id: p.id,
      label: p.label,
      postsPerDay: p.postsPerDay,
      fee: lifetimeFee(p.postsPerDay),
    })),
    socialAccounts: socialAccounts.map((a) => ({
      id: a.id,
      pageName: a.pageName,
      platform: a.platform,
    })),
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
  const { posts, activePackage, packages, fees, boughtPackages, lifetime, lifetimePacks, socialAccounts } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [buyError, setBuyError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("09:00");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [pkgFilter, setPkgFilter] = useState<string>("all");
  const [ltBusy, setLtBusy] = useState(false);
  const [ltPack, setLtPack] = useState<string | null>(null);
  // Lifetime activation form (topic/goal/page/time for the daily worker).
  const [ltFormPack, setLtFormPack] = useState<string | null>(null);
  const [ltTopic, setLtTopic] = useState("");
  const [ltGoal, setLtGoal] = useState("Increase Sales");
  const [ltPage, setLtPage] = useState("");
  const [ltTime, setLtTime] = useState("09:00");

  const lifetimeAction = async (
    action: string,
    packId?: string,
    cfg?: { topic: string; goal: string; socialAccountId: string; postTime: string },
  ) => {
    setBuyError(null);
    setLtBusy(true);
    try {
      const res = await fetch("/api/schedule/lifetime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, packId, ...(cfg ?? {}) }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      if (data.ok) {
        setLtFormPack(null);
        revalidator.revalidate();
      } else {
        setBuyError(data.message || "Couldn't update lifetime package.");
      }
    } catch {
      setBuyError("Couldn't reach the server.");
    } finally {
      setLtBusy(false);
    }
  };

  const visiblePosts =
    pkgFilter === "all"
      ? posts
      : pkgFilter === "manual"
        ? posts.filter((p) => !p.packageId)
        : posts.filter((p) => p.packageId === pkgFilter);

  const rowAction = async (id: string, act: "update" | "delete") => {
    setRowBusy(id);
    try {
      const res = await fetch("/api/schedule/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          act === "delete"
            ? { id, action: "delete" }
            : { id, action: "update", content: editContent, date: editDate, time: editTime },
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

  const rows = visiblePosts.map((p) => [
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
            setEditTime(iso ? iso.slice(11, 16) : "09:00");
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
        <Anim index={0}>
          <Hero
            title="Scheduled Posts"
            subtitle="Plan, schedule and auto-post your content"
          />
        </Anim>

        {/* ── Active package banner ── */}
        {activePackage && (
          <Anim index={1}>
            <Banner
              title={`${activePackage.label} active`}
              tone="success"
            >
              <Text as="p" variant="bodyMd">
                {activePackage.usedPosts} of {activePackage.totalPosts} posts used ·
                expires {new Date(activePackage.endsAt).toLocaleDateString()}
              </Text>
            </Banner>
          </Anim>
        )}

        {/* ── Auto-schedule packages ── */}
        <Anim index={2}>
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
                <div className="ap-card-hover">
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
                      >
                        Select & setup
                      </Button>
                    </BlockStack>
                  </Box>
                </Card>
                </div>
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
        </Anim>

        {/* ── Lifetime promo ── */}
        <Anim index={3}>
          <PromoBanner
            icon="♾️"
            title="Lifetime Auto-Post — save 25%"
            description="One activation covers up to 10 posts a day for 3 months. No daily fees, no renewals to remember."
          />
        </Anim>

        {/* ── Lifetime Auto-Post ── */}
        <Anim index={3}>
        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  ♾️ Lifetime Auto-Post
                </Text>
                {lifetime && (
                  <Badge tone="success">Active</Badge>
                )}
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                Billed per 3 months upfront (25% off) · 3-month minimum term ·
                auto-renews unless turned off
              </Text>
              {lifetime ? (
                <BlockStack gap="200">
                  <InlineStack gap="400">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">Posts per day</Text>
                      <Text as="p" variant="headingMd">{lifetime.postsPerDay}</Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">Current term ends</Text>
                      <Text as="p" variant="headingMd">
                        {new Date(lifetime.endsAt).toLocaleDateString()}
                      </Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">Auto-renew</Text>
                      <Text as="p" variant="headingMd">
                        {lifetime.autoRenew ? "On" : "Off"}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <InlineStack gap="200">
                    <Button
                      loading={ltBusy}
                      onClick={() => void lifetimeAction("toggle-renew")}
                    >
                      Turn auto-renew {lifetime.autoRenew ? "off" : "on"}
                    </Button>
                    <Button
                      tone="critical"
                      variant="plain"
                      loading={ltBusy}
                      onClick={() => void lifetimeAction("cancel")}
                    >
                      Cancel (after 3-month term)
                    </Button>
                  </InlineStack>
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  <Grid>
                    {lifetimePacks.map((p, idx) => (
                      <Grid.Cell
                        key={p.id}
                        columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}
                      >
                        <div className="ap-card-hover">
                        <Card>
                          <Box padding="400">
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="h3" variant="headingMd">
                                  {p.label}
                                </Text>
                                {idx === lifetimePacks.length - 1 && (
                                  <Badge tone="success">Best value</Badge>
                                )}
                              </InlineStack>
                              <Text as="p" variant="heading2xl">
                                ${p.fee.toFixed(2)}
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {p.postsPerDay} posts/day · 3 months
                              </Text>
                              <Button
                                variant="primary"
                                loading={ltBusy && ltPack === p.id}
                                disabled={ltBusy}
                                onClick={() => {
                                  setLtPack(p.id);
                                  setLtFormPack(ltFormPack === p.id ? null : p.id);
                                  if (!ltPage && socialAccounts.length > 0) {
                                    setLtPage(socialAccounts[0].id);
                                  }
                                }}
                              >
                                {ltFormPack === p.id ? "Close" : "Activate"}
                              </Button>
                              {ltFormPack === p.id && (
                                <BlockStack gap="200">
                                  <Text as="p" variant="bodySm" tone="subdued">
                                    Tell us what to post about — our worker auto-generates{" "}
                                    {p.postsPerDay} posts every day.
                                  </Text>
                                  <Select
                                    label="Facebook Page"
                                    options={socialAccounts.map((a) => ({
                                      label: `${a.pageName} (${a.platform})`,
                                      value: a.id,
                                    }))}
                                    value={ltPage}
                                    onChange={setLtPage}
                                  />
                                  <TextField
                                    label="Topic"
                                    value={ltTopic}
                                    onChange={setLtTopic}
                                    placeholder="e.g. Summer sale on watches"
                                    autoComplete="off"
                                  />
                                  <TextField
                                    label="Goal"
                                    value={ltGoal}
                                    onChange={setLtGoal}
                                    placeholder="e.g. Increase Sales"
                                    autoComplete="off"
                                  />
                                  <TextField
                                    label="First post time each day (UTC)"
                                    value={ltTime}
                                    onChange={setLtTime}
                                    placeholder="09:00"
                                    autoComplete="off"
                                    helpText="Posts are spread across the day from this time."
                                  />
                                  <Button
                                    variant="primary"
                                    loading={ltBusy}
                                    disabled={ltBusy || !ltTopic.trim() || !ltPage}
                                    onClick={() =>
                                      void lifetimeAction("activate", p.id, {
                                        topic: ltTopic.trim(),
                                        goal: ltGoal.trim() || "Increase Sales",
                                        socialAccountId: ltPage,
                                        postTime: ltTime.trim() || "09:00",
                                      })
                                    }
                                  >
                                    Confirm & Activate (${p.fee.toFixed(2)})
                                  </Button>
                                </BlockStack>
                              )}
                            </BlockStack>
                          </Box>
                        </Card>
                        </div>
                      </Grid.Cell>
                    ))}
                  </Grid>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Charged upfront for 3 months. Locked for the first 3 months —
                    then auto-renews every 3 months unless you turn it off.
                  </Text>
                </BlockStack>
              )}
            </BlockStack>
          </Box>
        </Card>
        </Anim>

        {/* ── Per-post fees ── */}
        <Anim index={4}>
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
        </Anim>

        {/* ── Posts table ── */}
        <Anim index={4}>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
              Posts {pkgFilter !== "all" && `(${visiblePosts.length})`}
            </Text>
            <div style={{ minWidth: "220px" }}>
              <Select
                label="Filter by package"
                labelHidden
                options={[
                  { label: "All posts", value: "all" },
                  { label: "Manual posts", value: "manual" },
                  ...boughtPackages.map((b) => ({ label: b.label, value: b.id })),
                ]}
                value={pkgFilter}
                onChange={setPkgFilter}
              />
            </div>
          </InlineStack>
        {visiblePosts.length === 0 ? (
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
        </BlockStack>
        </Anim>

        {/* ── Edit modal ── */}
        {editingId && (
          <Anim index={4}>
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
                  label="Time (UTC)"
                  type="time"
                  value={editTime}
                  onChange={setEditTime}
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
          </Anim>
        )}
      </BlockStack>
    </Page>
  );
}
