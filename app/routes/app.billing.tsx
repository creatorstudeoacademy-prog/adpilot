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
  List,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getWallet } from "../lib/wallet.server";
import { TOPUP_PACKS, POST_PUBLISH_FEE, OBJECTIVE_FEES } from "../lib/pricing";
import { NavButton } from "../components/NavButton";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const wallet = await getWallet(session.shop);
  return json({ balance: wallet.balance });
};

export default function BillingPage() {
  const { balance } = useLoaderData<typeof loader>();

  return (
    <Page title="Pricing" subtitle="No monthly fees — pay only for what you use">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    How pricing works
                  </Text>
                  <Badge tone="success">Free to install</Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd">
                  AdPilot has <strong>no monthly subscription</strong>. Top up
                  your wallet once, then pay a small fee only when you publish.
                </Text>
                <List type="bullet">
                  <List.Item>
                    Social post publish — ${POST_PUBLISH_FEE.toFixed(2)} per post
                  </List.Item>
                  <List.Item>
                    Ad publish — ${OBJECTIVE_FEES.AWARENESS.toFixed(2)} Awareness, $
                    {OBJECTIVE_FEES.TRAFFIC.toFixed(2)} Traffic / Engagement, $
                    {OBJECTIVE_FEES.SALES.toFixed(2)} Sales
                  </List.Item>
                  <List.Item>
                    +$1.50 per extra ad set, +$1.00 per extra creative
                  </List.Item>
                  <List.Item>
                    Your ad budget is billed separately by Meta to your ad
                    account — AdPilot never touches it.
                  </List.Item>
                </List>
                <Text as="p" variant="bodyMd">
                  Current wallet balance: <strong>${balance.toFixed(2)}</strong>
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Top up your wallet
                </Text>
                <Grid>
                  {TOPUP_PACKS.map((pack) => (
                    <Grid.Cell
                      key={pack.price}
                      columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}
                    >
                      <Card>
                        <BlockStack gap="200">
                          <Text as="p" variant="headingLg">
                            {pack.label}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {pack.sublabel}
                          </Text>
                          <NavButton url="/app/wallet" variant="primary">
                            Top up
                          </NavButton>
                        </BlockStack>
                      </Card>
                    </Grid.Cell>
                  ))}
                </Grid>
              </BlockStack>
            </Card>

            <Text as="p" variant="bodySm" tone="subdued">
              Topups are one-time charges handled securely by Shopify and appear
              on your regular Shopify invoice. Wallet credit never expires.
            </Text>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
