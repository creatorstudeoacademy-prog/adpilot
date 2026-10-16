import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Grid,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";

import { PRO_PLAN, authenticate } from "../shopify.server";

const IS_TEST_BILLING = process.env.NODE_ENV !== "production";
const PLAN_PRICE = "$9.99";
const PLAN_NAME = "AdPilot Starter";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);

  const check = await billing.check({
    plans: [PRO_PLAN],
    isTest: IS_TEST_BILLING,
  });

  const activeSubscription = (check.appSubscriptions ?? []).find(
    (sub) => sub.status === "ACTIVE",
  );

  return json({
    isPro: check.hasActivePayment,
    subscriptionId: activeSubscription?.id ?? null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upgrade") {
    // Throws a redirect Response to Shopify's hosted confirmation page.
    await billing.request({
      plan: PRO_PLAN,
      isTest: IS_TEST_BILLING,
      trialDays: 7,
      returnUrl: "/app/billing",
    });
  }

  if (intent === "downgrade") {
    const subscriptionId = String(formData.get("subscriptionId") ?? "");
    if (subscriptionId) {
      await billing.cancel({
        subscriptionId,
        isTest: IS_TEST_BILLING,
        prorate: true,
      });
    }
    return json({ ok: true });
  }

  return json({ ok: false });
};

export default function BillingPage() {
  const { isPro, subscriptionId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state === "submitting";

  const post = (intent: string) => {
    const data = new FormData();
    data.set("intent", intent);
    if (subscriptionId) data.set("subscriptionId", subscriptionId);
    submit(data, { method: "post" });
  };

  return (
    <Page title="Billing" subtitle="Choose the plan that fits your business">
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {actionData && "ok" in actionData && actionData.ok && (
              <Banner tone="success" onDismiss={() => {}}>
                Your plan was updated.
              </Banner>
            )}

            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
                <Card>
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">
                        Free{" "}
                        {!isPro && <Badge tone="success">Current plan</Badge>}
                      </Text>
                      <Text as="p" variant="heading2xl">
                        $0
                      </Text>
                      <List type="bullet">
                        <List.Item>Connect 1 Facebook Page</List.Item>
                        <List.Item>5 scheduled posts per month</List.Item>
                        <List.Item>Publish to Facebook</List.Item>
                      </List>
                    </BlockStack>
                    {!isPro ? (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        You are on the Free plan.
                      </Text>
                    ) : (
                      <Button disabled={busy} onClick={() => post("downgrade")}>
                        Downgrade to Free
                      </Button>
                    )}
                  </BlockStack>
                </Card>
              </Grid.Cell>

              <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
                <Card>
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">
                        {PLAN_NAME}{" "}
                        {isPro && <Badge tone="success">Current plan</Badge>}
                      </Text>
                      <Text as="p" variant="heading2xl">
                        {PLAN_PRICE}
                        <Text as="span" variant="bodyMd" tone="subdued">
                          {" "}
                          / month
                        </Text>
                      </Text>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        7-day free trial included
                      </Text>
                      <List type="bullet">
                        <List.Item>Unlimited connected Pages</List.Item>
                        <List.Item>Unlimited scheduled posts</List.Item>
                        <List.Item>Post, Reel & Video publishing</List.Item>
                        <List.Item>Facebook + Instagram publishing</List.Item>
                        <List.Item>Priority support</List.Item>
                      </List>
                    </BlockStack>
                    {isPro ? (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        You are on the {PLAN_NAME} plan.
                      </Text>
                    ) : (
                      <Button
                        variant="primary"
                        disabled={busy}
                        loading={busy}
                        onClick={() => post("upgrade")}
                      >
                        Upgrade to {PLAN_NAME}
                      </Button>
                    )}
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>

            <Text as="p" variant="bodySm" tone="subdued">
              Billing is handled securely by Shopify. Charges appear on your
              regular Shopify invoice and can be cancelled anytime.
            </Text>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
