import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, Form } from "@remix-run/react";
import { useEffect, useState } from "react";
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
  TextField,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getTransactions, getWallet } from "../lib/wallet.server";
import { TOPUP_PACKS } from "../lib/pricing";
import { Anim, Hero, PromoBanner } from "../components/ui";

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
    if (coupon.trim()) data.set("coupon", coupon.trim().toUpperCase());
    submit(data, { method: "post", action: "/app/wallet/topup" });
  };

  const [coupon, setCoupon] = useState("");
  const [couponState, setCouponState] = useState<{
    ok: boolean;
    bonusPercent?: number;
    error?: string;
  } | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);
  const [myCoupons, setMyCoupons] = useState<Array<{
    code: string;
    bonusPercent: number;
    expiresAt: string;
    expired: boolean;
    used: boolean;
  }>>([]);
  const [reqBusy, setReqBusy] = useState(false);
  const [reqMsg, setReqMsg] = useState<string | null>(null);

  // Load coupons sent to this shop.
  useEffect(() => {
    fetch("/api/coupons/mine")
      .then((r) => r.json())
      .then((d) => setMyCoupons(d.coupons ?? []))
      .catch(() => {});
  }, []);

  const requestCoupon = async () => {
    setReqBusy(true);
    setReqMsg(null);
    try {
      const res = await fetch("/api/coupons/mine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setReqMsg(data.ok ? data.message : data.error);
    } catch {
      setReqMsg("Couldn't send the request.");
    } finally {
      setReqBusy(false);
    }
  };

  const checkCoupon = async () => {
    const code = coupon.trim().toUpperCase();
    if (!code) return;
    setCouponChecking(true);
    setCouponState(null);
    try {
      const res = await fetch("/api/wallet/validate-coupon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      setCouponState(data.ok ? { ok: true, bonusPercent: data.bonusPercent } : { ok: false, error: data.error });
    } catch {
      setCouponState({ ok: false, error: "Couldn't check the coupon." });
    } finally {
      setCouponChecking(false);
    }
  };

  const rows = transactions.map((t) => [
    new Date(t.createdAt).toLocaleDateString(),
    t.description ?? "—",
    typeBadge(t.type, t.amount),
  ]);

  return (
    <Page title="Wallet" subtitle="Prepaid credit for your ad spend">
      <BlockStack gap="500">
        <Anim index={0}>
          <Hero
            title={`$${balance.toFixed(2)}`}
            subtitle="Current balance — top up to keep your campaigns running"
          />
        </Anim>
        <Anim index={1}>
          <PromoBanner
            icon="🎟️"
            title="Got a coupon code? Get up to 20% extra bonus!"
            description="Enter your coupon below before topping up — bonus credit lands instantly. Each code works once per store."
          />
        </Anim>
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
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    🎟️ Have a coupon code?
                  </Text>
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ flexGrow: 1 }}>
                      <TextField
                        label="Coupon code"
                        labelHidden
                        value={coupon}
                        onChange={(v) => {
                          setCoupon(v);
                          setCouponState(null);
                        }}
                        placeholder="e.g. WELCOME10"
                        autoComplete="off"
                      />
                    </div>
                    <Button loading={couponChecking} onClick={() => void checkCoupon()}>
                      Apply
                    </Button>
                  </InlineStack>
                  {couponState?.ok && (
                    <Banner tone="success">
                      ✓ {couponState.bonusPercent}% bonus credit applied to your top-up!
                    </Banner>
                  )}
                  {couponState && !couponState.ok && (
                    <Banner tone="critical">{couponState.error}</Banner>
                  )}
                </BlockStack>

                {/* My coupons */}
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      🎟️ My coupons
                    </Text>
                    <Button variant="plain" loading={reqBusy} onClick={() => void requestCoupon()}>
                      Request a coupon
                    </Button>
                  </InlineStack>
                  {reqMsg && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {reqMsg}
                    </Text>
                  )}
                  {myCoupons.length === 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      No coupons yet — request one above!
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      {myCoupons.map((c) => (
                        <Box
                          key={c.code}
                          background="bg-surface-secondary"
                          borderRadius="200"
                          padding="300"
                        >
                          <InlineStack align="space-between" blockAlign="center">
                            <BlockStack gap="050">
                              <Text as="p" variant="bodyMd" fontWeight="semibold">
                                {c.code}
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {c.bonusPercent}% bonus · expires{" "}
                                {new Date(c.expiresAt).toLocaleDateString()}
                                {c.used && " · ✓ used"}
                                {c.expired && !c.used && " · expired"}
                              </Text>
                            </BlockStack>
                            {!c.used && !c.expired && (
                              <Button
                                size="slim"
                                onClick={() => {
                                  setCoupon(c.code);
                                  setCouponState({
                                    ok: true,
                                    bonusPercent: c.bonusPercent,
                                  });
                                }}
                              >
                                Apply
                              </Button>
                            )}
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
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
