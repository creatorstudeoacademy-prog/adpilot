import { useState } from "react";
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
  Checkbox,
  ChoiceList,
  FormLayout,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { publishToPlatforms } from "../lib/meta.server";
import { deduct, getWallet, refund } from "../lib/wallet.server";
import { POST_PUBLISH_FEE } from "../lib/pricing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const accounts = await prisma.socialAccount.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const wallet = await prisma.wallet.findUnique({
    where: { shop: session.shop },
  });

  return json({
    accounts: accounts.map((a) => ({
      id: a.id,
      pageName: a.pageName,
      platform: a.platform,
      instagramId: a.instagramId,
    })),
    walletBalance: wallet?.balance ?? 0,
  });
};

interface ComposeActionData {
  ok: boolean;
  error?: string;
  published?: boolean;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const accountId = String(formData.get("accountId") ?? "");
  const content = String(formData.get("content") ?? "").trim();
  const mediaUrl = String(formData.get("mediaUrl") ?? "").trim();
  const mediaType = String(formData.get("mediaType") ?? "post");
  const platforms = JSON.parse(String(formData.get("platforms") ?? '["facebook"]'));
  const publishNow = formData.get("publishNow") === "on";
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "");

  if (!accountId) {
    return json<ComposeActionData>(
      { ok: false, error: "Choose a connected account first." },
      { status: 400 },
    );
  }
  if (!content && !mediaUrl) {
    return json<ComposeActionData>(
      { ok: false, error: "Write something or add a media URL." },
      { status: 400 },
    );
  }

  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, shop },
  });
  if (!account) {
    return json<ComposeActionData>(
      { ok: false, error: "Account not found." },
      { status: 404 },
    );
  }

  const mediaUrls = mediaUrl ? [mediaUrl] : [];

  // Wallet check: $0.50 per post publish (scheduled posts are charged now,
  // at schedule time).
  const wallet = await getWallet(shop);
  if (wallet.balance < POST_PUBLISH_FEE) {
    return json<ComposeActionData>(
      {
        ok: false,
        error: `Insufficient wallet balance ($${wallet.balance.toFixed(2)}). Publishing costs $${POST_PUBLISH_FEE.toFixed(2)} per post — please top up.`,
      },
      { status: 402 },
    );
  }

  if (publishNow) {
    // Create the record first so we have an id for the transaction ref.
    const post = await prisma.scheduledPost.create({
      data: {
        shop,
        socialAccountId: account.id,
        content,
        mediaUrls: JSON.stringify(mediaUrls),
        mediaType,
        platforms: JSON.stringify(platforms),
        status: "draft",
      },
    });

    // Deduct BEFORE calling Meta; refund if Meta fails.
    await deduct(shop, POST_PUBLISH_FEE, `Post publish fee`, post.id);

    try {
      await publishToPlatforms({
        accessToken: account.accessToken,
        pageId: account.pageId,
        instagramId: account.instagramId,
        content,
        mediaUrls,
        mediaType,
        platforms,
      });
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "published", publishedAt: new Date() },
      });
      return json<ComposeActionData>({ ok: true, published: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Publishing failed.";
      await refund(shop, POST_PUBLISH_FEE, `Refund: post publish failed`, post.id);
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "failed", error: message },
      });
      return json<ComposeActionData>({ ok: false, error: message }, { status: 500 });
    }
  }

  // Schedule for later
  if (!scheduledAtRaw) {
    return json<ComposeActionData>(
      { ok: false, error: "Pick a date and time, or choose Post now." },
      { status: 400 },
    );
  }
  const scheduledAt = new Date(scheduledAtRaw);
  if (isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
    return json<ComposeActionData>(
      { ok: false, error: "Scheduled time must be in the future." },
      { status: 400 },
    );
  }

  const post = await prisma.scheduledPost.create({
    data: {
      shop,
      socialAccountId: account.id,
      content,
      mediaUrls: JSON.stringify(mediaUrls),
      mediaType,
      platforms: JSON.stringify(platforms),
      scheduledAt,
      status: "scheduled",
    },
  });

  // Charge the publish fee now, at schedule time.
  await deduct(shop, POST_PUBLISH_FEE, `Scheduled post fee`, post.id);

  return redirect("/app/scheduled");
};

export default function ComposePage() {
  const { accounts, walletBalance } = useLoaderData<typeof loader>();
  const actionData = useActionData<ComposeActionData>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state === "submitting";

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [content, setContent] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaType, setMediaType] = useState("post");
  const [platforms, setPlatforms] = useState<string[]>(["facebook"]);
  const [publishNow, setPublishNow] = useState(true);
  const [scheduledAt, setScheduledAt] = useState("");

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const instagramAvailable = Boolean(selectedAccount?.instagramId);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData();
    data.set("accountId", accountId);
    data.set("content", content);
    data.set("mediaUrl", mediaUrl);
    data.set("mediaType", mediaType);
    data.set("platforms", JSON.stringify(platforms));
    if (publishNow) data.set("publishNow", "on");
    data.set("scheduledAt", scheduledAt);
    submit(data, { method: "post" });
  };

  return (
    <Page title="Compose" subtitle="Create a post, reel, or video">
      <BlockStack gap="500">
        {actionData && !actionData.ok && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}
        {actionData?.ok && actionData.published && (
          <Banner tone="success" onDismiss={() => {}}>
            Your post was published!
          </Banner>
        )}

        {accounts.length === 0 ? (
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                Connect a Facebook Page first to start posting.
              </Text>
              <Button url="/app/accounts" variant="primary">
                Go to Accounts
              </Button>
            </BlockStack>
          </Card>
        ) : (
          <form onSubmit={handleSubmit}>
            <Layout>
              <Layout.Section>
                <BlockStack gap="500">
                  <Card>
                    <BlockStack gap="400">
                      <FormLayout>
                        <Select
                          label="Post from"
                          options={accounts.map((a) => ({
                            label: `${a.pageName} (Facebook)`,
                            value: a.id,
                          }))}
                          value={accountId}
                          onChange={setAccountId}
                        />
                        <TextField
                          label="Content"
                          value={content}
                          onChange={setContent}
                          multiline={5}
                          placeholder="Write your post…"
                          autoComplete="off"
                        />
                        <TextField
                          label="Media URL (optional)"
                          value={mediaUrl}
                          onChange={setMediaUrl}
                          placeholder="https://… direct link to image or video"
                          helpText="Paste a direct link to an image or video file."
                          autoComplete="off"
                        />
                        <Select
                          label="Post type"
                          options={[
                            { label: "Post", value: "post" },
                            { label: "Reel", value: "reel" },
                            { label: "Video", value: "video" },
                          ]}
                          value={mediaType}
                          onChange={setMediaType}
                          helpText="Reels and videos need a video media URL."
                        />
                      </FormLayout>
                    </BlockStack>
                  </Card>
                </BlockStack>
              </Layout.Section>

              <Layout.Section variant="oneThird">
                <BlockStack gap="500">
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Platforms
                      </Text>
                      <ChoiceList
                        title="Publish to"
                        titleHidden
                        choices={[
                          { label: "Facebook", value: "facebook" },
                          {
                            label: "Instagram",
                            value: "instagram",
                            disabled: !instagramAvailable,
                          },
                        ]}
                        selected={platforms}
                        onChange={setPlatforms}
                        allowMultiple
                      />
                      {!instagramAvailable && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Link an Instagram Business account to your Page to
                          enable Instagram publishing.
                        </Text>
                      )}
                    </BlockStack>
                  </Card>

                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Timing
                      </Text>
                      <Checkbox
                        label="Post now"
                        checked={publishNow}
                        onChange={setPublishNow}
                      />
                      {!publishNow && (
                        <TextField
                          label="Schedule for"
                          type="datetime-local"
                          value={scheduledAt}
                          onChange={setScheduledAt}
                          autoComplete="off"
                        />
                      )}
                      <Button
                        variant="primary"
                        submit
                        loading={busy}
                        disabled={busy}
                        fullWidth
                      >
                        {publishNow ? "Publish now ($0.50)" : "Schedule post ($0.50)"}
                      </Button>
                      <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                        $0.50 will be deducted from your wallet (balance: $
                        {walletBalance.toFixed(2)}).
                      </Text>
                    </BlockStack>
                  </Card>
                </BlockStack>
              </Layout.Section>
            </Layout>
          </form>
        )}
      </BlockStack>
    </Page>
  );
}
