import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Grid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { NavButton } from "../components/NavButton";
import { Anim, Hero, PromoBanner } from "../components/ui";
import StrategyBar from "../components/StrategyBar";
import DataDoctor from "../components/DataDoctor";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [adAccounts, campaigns] = await Promise.all([
    prisma.adAccount.findMany({ where: { shop } }),
    prisma.campaign.findMany({ where: { shop }, orderBy: { createdAt: "desc" } }),
  ]);

  const activeCount = campaigns.filter((c) => c.status === "active").length;
  const totalBudgetReserved = campaigns
    .filter((c) => c.status === "active")
    .reduce((sum, c) => sum + c.dailyBudget, 0);

  return json({
    adAccounts: adAccounts.map((a) => ({
      id: a.id,
      adAccountName: a.adAccountName,
      currency: a.currency,
    })),
    activeCount,
    campaignCount: campaigns.length,
    totalBudgetReserved,
  });
};

export default function AdsDashboard() {
  const { adAccounts, activeCount, campaignCount, totalBudgetReserved } =
    useLoaderData<typeof loader>();

  return (
    <Page
      title="Ads Manager"
      subtitle="Run Facebook & Instagram ads the easy way"
      primaryAction={
        adAccounts.length > 0
          ? { content: "Create campaign", url: "/app/ads/create" }
          : undefined
      }
      secondaryActions={
        adAccounts.length > 0
          ? [{ content: "Full-funnel campaign", url: "/app/ads/funnel" }]
          : undefined
      }
    >
      <BlockStack gap="500">
        <Anim index={0}>
          <Hero
            title="Ads Manager"
            subtitle="Run Facebook & Instagram ads the easy way"
          />
        </Anim>
        {adAccounts.length > 0 && (
          <Anim index={1}>
            <StrategyBar />
          <DataDoctor />
          </Anim>
        )}
        {adAccounts.length === 0 ? (
          <Anim index={1}>
            <div className="ap-card-hover">
              <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Connect your ad account
              </Text>
              <Text as="p" variant="bodyMd">
                Connect your Meta ad account to start creating campaigns.
                Pick an objective, set a budget, write your ad — AdPilot
                handles the rest.
              </Text>
              <InlineStack>
                <NavButton variant="primary" url="/app/ads/connect">
                  Connect ad account
                </NavButton>
              </InlineStack>
            </BlockStack>
              </Card>
            </div>
          </Anim>
        ) : (
          <>
            <Anim index={1}>
              <PromoBanner
                icon="🚀"
                title="Try the Full-Funnel Campaign"
                description="One click — 3 campaigns, 3 audiences, full funnel live."
              />
            </Anim>
            <Layout>
              <Layout.Section>
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                    <Anim index={2}>
                      <div className="ap-stat-card">
                        <Card>
                          <BlockStack gap="200">
                            <Text as="p" variant="bodyMd" tone="subdued">
                              Active campaigns
                            </Text>
                            <Text as="p" variant="headingXl">
                              {activeCount}
                            </Text>
                          </BlockStack>
                        </Card>
                      </div>
                    </Anim>
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                    <Anim index={3}>
                      <div className="ap-stat-card">
                        <Card>
                          <BlockStack gap="200">
                            <Text as="p" variant="bodyMd" tone="subdued">
                              Total campaigns
                            </Text>
                            <Text as="p" variant="headingXl">
                              {campaignCount}
                            </Text>
                          </BlockStack>
                        </Card>
                      </div>
                    </Anim>
                  </Grid.Cell>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                    <Anim index={4}>
                      <div className="ap-stat-card">
                        <Card>
                          <BlockStack gap="200">
                            <Text as="p" variant="bodyMd" tone="subdued">
                              Daily budget reserved
                            </Text>
                            <Text as="p" variant="headingXl">
                              ${totalBudgetReserved.toFixed(2)}
                            </Text>
                          </BlockStack>
                        </Card>
                      </div>
                    </Anim>
                  </Grid.Cell>
                </Grid>
              </Layout.Section>
            </Layout>

            <Anim index={3}>
              <div className="ap-card-hover">
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Connected ad accounts
                      </Text>
                      <NavButton url="/app/ads/connect">Add account</NavButton>
                    </InlineStack>
                    <BlockStack gap="200">
                      {adAccounts.map((a) => (
                        <InlineStack key={a.id} align="space-between">
                          <Text as="p" variant="bodyMd">
                            {a.adAccountName}
                          </Text>
                          <Badge tone="success">Connected</Badge>
                        </InlineStack>
                      ))}
                    </BlockStack>
                    <InlineStack gap="300">
                      <NavButton variant="primary" url="/app/ads/create">
                        Create campaign
                      </NavButton>
                      <NavButton url="/app/ads/campaigns">View campaigns</NavButton>
                    </InlineStack>
                  </BlockStack>
                </Card>
              </div>
            </Anim>
          </>
        )}
      </BlockStack>
    </Page>
  );
}
