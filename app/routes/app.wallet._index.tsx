import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, Form } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  Grid,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getTransactions, getWallet } from "../lib/wallet.server";
import { TOPUP_PACKS } from "../lib/pricing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const wallet = await getWallet(shop);
  const transactions = await getTransactions(shop);

  const url = new URL(request.url);
  return json({
    balance: wallet.balance,
    currency: wallet.currency,
    need: url.searchParams.get("need"),
    topped: url.searchParams.get("topped") === "1",
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      type: t.type,
      description: t.description,
      createdAt: t.createdAt,
    })),
  });
};

function typeBadge(type: string, amount: number) {
  const label = type === "topup" ? "Topup" : type === "refund" ? "Refund" : "Ad spend";
  const sign = amount >= 0 ? "+" : "−";
  return `${label} ${sign}$${Math.abs(amount).toFixed(2)}`;
}

export default function WalletPage() {
  const { balance, need, topped, transactions } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  const topup = (amount: number) => {
    const data = new FormData();
    data.set("amount", String(amount));
    submit(data, { method: "post", action: "/app/wallet/topup" });
  };

  const rows = transactions.map((t) => [
    new Date(t.createdAt).toLocaleDateString(),
    t.description ?? "—",
    typeBadge(t.type, t.amount),
  ]);

  return (
    <Page title="Wallet" subtitle="Prepaid credit for your ad spend">
      <BlockStack gap="500">
        {need && (
          <Banner tone="warning">
            You need at least ${need} to publish that campaign. Top up below.
          </Banner>
        )}
        {topped && (
          <Banner tone="success">
            Topup successful! Your new balance is ready to use.
          </Banner>
        )}

        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
            <Card>
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd" tone="subdued">
                  Current balance
                </Text>
                <Text as="p" variant="heading2xl">
                  ${balance.toFixed(2)}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Publishing fees are deducted per ad: $2 Awareness, $2.50
                  Traffic/Engagement, $3 Sales — plus $1.50 per extra ad set
                  and $1 per extra creative. Your ad budget is billed
                  separately by Meta to your ad account. If publishing
                  fails, you are refunded automatically.
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Top up
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Charged once via Shopify. Credit lands in your wallet
                  instantly.
                </Text>
                <Grid>
                  {TOPUP_PACKS.map((pack) => (
                    <Grid.Cell key={String(pack.price)} columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                      <Button
                        fullWidth
                        disabled={busy}
                        onClick={() => topup(pack.price)}
                      >
                        {pack.label}
                      </Button>
                      <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                        {pack.sublabel}
                      </Text>
                    </Grid.Cell>
                  ))}
                </Grid>
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Transaction history
            </Text>
            {transactions.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No transactions yet.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["Date", "Description", "Amount"]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
