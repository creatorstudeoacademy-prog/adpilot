import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
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

  const accounts = await prisma.socialAccount.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  const metaAppId = process.env.META_APP_ID ?? "";

  return json({
    shop,
    metaConfigured: metaAppId.length > 0,
    accounts: accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      pageName: a.pageName,
      pageId: a.pageId,
      instagramId: a.instagramId,
      createdAt: a.createdAt.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "disconnect") {
    const id = String(formData.get("id") ?? "");
    await prisma.socialAccount.deleteMany({
      where: { id, shop: session.shop },
    });
    return json({ ok: true });
  }

  return json({ ok: false });
};

export default function AccountsPage() {
  const { metaConfigured, accounts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state === "submitting";

  const disconnect = (id: string) => {
    const data = new FormData();
    data.set("intent", "disconnect");
    data.set("id", id);
    submit(data, { method: "post" });
  };

  return (
    <Page
      title="Connected Accounts"
      subtitle="Connect your Facebook Pages and Instagram accounts"
      primaryAction={
        metaConfigured
          ? { content: "Connect Facebook", url: "/auth/meta" }
          : undefined
      }
    >
      <BlockStack gap="500">
        {actionData && "ok" in actionData && actionData.ok && (
          <Banner tone="success" onDismiss={() => {}}>
            Account disconnected.
          </Banner>
        )}

        {!metaConfigured && (
          <Banner tone="warning" title="Meta app not configured">
            The Meta app credentials (META_APP_ID / META_APP_SECRET) are not
            set yet. Add them to the app's environment variables to enable
            Facebook connect.
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            {accounts.length === 0 ? (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    No accounts connected yet
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Connect your Facebook Page to start publishing posts,
                    reels, and videos. If your Page has a linked Instagram
                    Business account, it will be connected automatically.
                  </Text>
                  {metaConfigured && (
                    <InlineStack>
                      <Button variant="primary" url="/auth/meta">
                        Connect Facebook
                      </Button>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            ) : (
              <BlockStack gap="400">
                {accounts.map((a) => (
                  <Card key={a.id}>
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingMd">
                          {a.pageName}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {a.platform === "facebook"
                            ? `Facebook Page · ${a.pageId}`
                            : `Instagram · ${a.instagramId ?? ""}`}
                        </Text>
                      </BlockStack>
                      <Button
                        tone="critical"
                        disabled={busy}
                        onClick={() => disconnect(a.id)}
                      >
                        Disconnect
                      </Button>
                    </InlineStack>
                  </Card>
                ))}
                {metaConfigured && (
                  <InlineStack>
                    <Button url="/auth/meta">Connect another Page</Button>
                  </InlineStack>
                )}
              </BlockStack>
            )}
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  What you get
                </Text>
                <Text as="p" variant="bodyMd">
                  Once connected you can publish posts, reels, and videos to
                  Facebook — and to Instagram when a Business account is
                  linked — instantly or on a schedule.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
