import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [accounts, scheduledCount, publishedCount] = await Promise.all([
    prisma.socialAccount.findMany({ where: { shop } }),
    prisma.scheduledPost.count({ where: { shop, status: "scheduled" } }),
    prisma.scheduledPost.count({ where: { shop, status: "published" } }),
  ]);

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
  });
};

export default function Dashboard() {
  const { accountCount, accounts, scheduledCount, publishedCount } =
    useLoaderData<typeof loader>();

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
        {accountCount === 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Welcome to AdPilot!
              </Text>
              <Text as="p" variant="bodyMd">
                Connect your Facebook Page to start scheduling posts, reels,
                and videos. You can publish instantly or schedule for later —
                to Facebook and Instagram.
              </Text>
              <InlineStack>
                <Button variant="primary" url="/app/accounts">
                  Connect your Facebook Page
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        <Layout>
          <Layout.Section>
            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Connected accounts
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {accountCount}
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Scheduled posts
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {scheduledCount}
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
              <Grid.Cell columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Published posts
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {publishedCount}
                    </Text>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>
          </Layout.Section>
        </Layout>

        {accountCount > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Connected pages
              </Text>
              <BlockStack gap="200">
                {accounts.map((a) => (
                  <InlineStack key={a.id} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodyMd">
                      {a.pageName}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {a.platform === "facebook" ? "Facebook Page" : "Instagram"}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
              <InlineStack gap="300">
                <Button url="/app/compose">Compose a post</Button>
                <Button url="/app/scheduled">View scheduled</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Coming soon
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Ads Manager — create and run Facebook & Instagram ads right from
              AdPilot. Messenger auto-reply is also on the roadmap.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
