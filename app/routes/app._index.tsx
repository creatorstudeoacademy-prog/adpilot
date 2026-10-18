import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Grid,
  Icon,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import {
  CalendarIcon,
  CashDollarIcon,
  ChatIcon,
  ConnectIcon,
  ImageIcon,
  MegaphoneIcon,
  SendIcon,
  TargetIcon,
} from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { NavButton } from "../components/NavButton";
import { ReviewShowcase } from "../components/ReviewShowcase";
import ReviewPromptBanner from "../components/ReviewPromptBanner";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [accounts, scheduledCount, publishedCount, activeCampaigns, wallet, recentActivity, topReviews] =
    await Promise.all([
      prisma.socialAccount.findMany({ where: { shop } }),
      prisma.scheduledPost.count({ where: { shop, status: "scheduled" } }),
      prisma.scheduledPost.count({ where: { shop, status: "published" } }),
      prisma.campaign.count({ where: { shop, status: "active" } }),
      prisma.wallet.findUnique({ where: { shop } }),
      prisma.activityLog.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { action: true, detail: true, createdAt: true },
      }),
      prisma.review.findMany({
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { author: true, rating: true, title: true, content: true },
      }),
    ]);

  const hasAccounts = accounts.length > 0;
  const hasPublished = publishedCount > 0;
  const hasCampaigns = activeCampaigns > 0;
  const setupSteps = [
    { label: "Connect your Facebook Page", done: hasAccounts, url: "/app/accounts" },
    { label: "Publish your first post", done: hasPublished, url: "/app/compose" },
    { label: "Launch your first ad campaign", done: hasCampaigns, url: "/app/ads/create" },
  ];
  const setupDone = setupSteps.filter((s) => s.done).length;

  return json({
    shop,
    accountCount: accounts.length,
    accounts: accounts.map((a) => ({
      id: a.id,
      pageName: a.pageName,
      platform: a.platform,
    })),
    scheduledCount,
    publishedCount,
    activeCampaigns,
    walletBalance: wallet?.balance ?? 0,
    setupSteps,
    setupDone,
    setupTotal: setupSteps.length,
    recentActivity: recentActivity.map((a) => ({
      action: a.action,
      detail: a.detail ?? "",
      createdAt: a.createdAt.toISOString(),
    })),
    topReviews,
  });
};

function StatCard({
  icon,
  label,
  value,
  url,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  url: string;
}) {
  return (
    <Card>
      <Box padding="400">
        <BlockStack gap="200">
          <Box background="bg-surface-secondary" borderRadius="200" padding="200">
            <Icon source={icon as never} tone="base" />
          </Box>
          <Text as="p" variant="heading2xl">
            {value}
          </Text>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodyMd" tone="subdued">
              {label}
            </Text>
            <NavButton url={url} variant="plain">
              View
            </NavButton>
          </InlineStack>
        </BlockStack>
      </Box>
    </Card>
  );
}

function QuickAction({
  icon,
  title,
  desc,
  url,
  primary,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  url: string;
  primary?: boolean;
}) {
  return (
    <div
      onClick={() => (window.location.href = url)}
      style={{ cursor: "pointer", height: "100%" }}
    >
      <Card>
        <Box padding="400">
          <BlockStack gap="200">
            <Box
              background={primary ? "bg-fill-brand" : "bg-surface-secondary"}
              borderRadius="200"
              padding="200"
            >
              <span style={primary ? { color: "#fff" } : undefined}>
                <Icon source={icon as never} tone="base" />
              </span>
            </Box>
            <Text as="h3" variant="headingMd">
              {title}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {desc}
            </Text>
          </BlockStack>
        </Box>
      </Card>
    </div>
  );
}

export default function Dashboard() {
  const {
    accountCount,
    accounts,
    scheduledCount,
    publishedCount,
    activeCampaigns,
    walletBalance,
    setupSteps,
    setupDone,
    setupTotal,
    recentActivity,
    topReviews,
  } = useLoaderData<typeof loader>();

  const showSetup = setupDone < setupTotal;

  return (
    <Page
      title="AdPilot Dashboard"
      subtitle="Your social media command center"
      primaryAction={
        accountCount === 0
          ? { content: "Connect Facebook", url: "/app/accounts" }
          : { content: "Compose post", url: "/app/compose" }
      }
    >
      <BlockStack gap="500">
        <ReviewPromptBanner />
        {/* ── Hero banner ── */}
        <Card>
          <div
            style={{
              background: "linear-gradient(135deg, #5c6ac4 0%, #202223 130%)",
              borderRadius: "8px",
              padding: "32px",
              color: "#fff",
            }}
          >
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingXl">
                    <span style={{ color: "#fff" }}>
                      {accountCount === 0 ? "Welcome to AdPilot ✈️" : "Ready to grow? ✈️"}
                    </span>
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <span style={{ color: "rgba(255,255,255,0.85)" }}>
                      {accountCount === 0
                        ? "Connect your Facebook Page and publish your first post in under 2 minutes."
                        : "Create posts, launch ad campaigns, and let AI do the heavy lifting."}
                    </span>
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm">
                    <span style={{ color: "rgba(255,255,255,0.75)" }}>
                      Wallet balance
                    </span>
                  </Text>
                  <Text as="p" variant="heading2xl">
                    <span style={{ color: "#fff" }}>${walletBalance.toFixed(2)}</span>
                  </Text>
                  <div>
                    <Button url="/app/wallet" variant="primary">
                      Top up
                    </Button>
                  </div>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </div>
        </Card>

        {/* ── Getting started checklist ── */}
        {showSetup && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Getting started
                  </Text>
                  <Badge tone="info">
                    {setupDone} of {setupTotal} done
                  </Badge>
                </InlineStack>
                <ProgressBar progress={(setupDone / setupTotal) * 100} tone="primary" />
                <BlockStack gap="200">
                  {setupSteps.map((s) => (
                    <InlineStack key={s.label} align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone={s.done ? "success" : undefined}>
                          {s.done ? "Done" : "To do"}
                        </Badge>
                        <Text
                          as="p"
                          variant="bodyMd"
                          textDecorationLine={s.done ? "line-through" : undefined}
                          tone={s.done ? "subdued" : undefined}
                        >
                          {s.label}
                        </Text>
                      </InlineStack>
                      {!s.done && (
                        <NavButton url={s.url} variant="plain">
                          Start
                        </NavButton>
                      )}
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            </Box>
          </Card>
        )}

        {/* ── Stats ── */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <StatCard
              icon={ConnectIcon}
              label="Connected accounts"
              value={accountCount}
              url="/app/accounts"
            />
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <StatCard
              icon={CalendarIcon}
              label="Scheduled posts"
              value={scheduledCount}
              url="/app/scheduled"
            />
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <StatCard
              icon={SendIcon}
              label="Published posts"
              value={publishedCount}
              url="/app/scheduled"
            />
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <StatCard
              icon={MegaphoneIcon}
              label="Active campaigns"
              value={activeCampaigns}
              url="/app/ads/campaigns"
            />
          </Grid.Cell>
        </Grid>

        {/* ── Quick actions ── */}
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Quick actions
          </Text>
          <Grid>
            <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
              <QuickAction
                icon={SendIcon}
                title="Compose post"
                desc="Write and publish to Facebook in seconds. $0.20/post"
                url="/app/compose"
                primary
              />
            </Grid.Cell>
            <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
              <QuickAction
                icon={TargetIcon}
                title="Create campaign"
                desc="Launch Meta ads from $2. AI fills your ad copy."
                url="/app/ads/create"
              />
            </Grid.Cell>
            <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
              <QuickAction
                icon={ImageIcon}
                title="AI caption writer"
                desc="Generate scroll-stopping captions. $0.20 each"
                url="/app/compose"
              />
            </Grid.Cell>
            <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
              <QuickAction
                icon={MegaphoneIcon}
                title="Full Funnel"
                desc="One-click 3-stage ad funnel. $10.50 all-in"
                url="/app/ads/funnel"
              />
            </Grid.Cell>
            <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
              <QuickAction
                icon={ChatIcon}
                title="Support Chat"
                desc="Ask AI anything about AdPilot. Free"
                url="/app/support"
              />
            </Grid.Cell>
            <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 4, xl: 4 }}>
              <QuickAction
                icon={CashDollarIcon}
                title="Top up wallet"
                desc="No subscriptions. Pay only for what you use."
                url="/app/wallet"
              />
            </Grid.Cell>
          </Grid>
        </BlockStack>

        {/* ── Connected pages + Recent activity ── */}
        <Layout>
          <Layout.Section>
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Connected pages
                    </Text>
                    <NavButton url="/app/accounts" variant="plain">
                      Manage
                    </NavButton>
                  </InlineStack>
                  {accountCount === 0 ? (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" tone="subdued">
                        No pages connected yet.
                      </Text>
                      <div>
                        <NavButton url="/app/accounts" variant="primary">
                          Connect Facebook Page
                        </NavButton>
                      </div>
                    </BlockStack>
                  ) : (
                    <BlockStack gap="200">
                      {accounts.map((a) => (
                        <InlineStack key={a.id} align="space-between" blockAlign="center">
                          <Text as="span" variant="bodyMd">
                            {a.pageName}
                          </Text>
                          <Badge>
                            {a.platform === "facebook" ? "Facebook Page" : "Instagram"}
                          </Badge>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Box>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Recent activity
                  </Text>
                  {recentActivity.length === 0 ? (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Your activity will show up here.
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      {recentActivity.map((a, i) => (
                        <BlockStack key={i} gap="050">
                          <Text as="p" variant="bodySm" fontWeight="medium">
                            {a.action.replace(/_/g, " ")}
                          </Text>
                          {a.detail && (
                            <Text as="p" variant="bodySm" tone="subdued" truncate>
                              {a.detail}
                            </Text>
                          )}
                          <Text as="p" variant="bodySm" tone="subdued">
                            {new Date(a.createdAt).toLocaleDateString()}
                          </Text>
                        </BlockStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Box>
            </Card>
          </Layout.Section>
        </Layout>

        <ReviewShowcase reviews={topReviews} />
      </BlockStack>
    </Page>
  );
}
