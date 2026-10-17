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
import { deduct, getWallet, isFreeShop, refund } from "../lib/wallet.server";
import { logActivity } from "../lib/activity.server";
import { POST_PUBLISH_FEE } from "../lib/pricing";
import { NavButton } from "../components/NavButton";

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
  // at schedule time). Free shops (owner's own stores) skip the check.
  const wallet = await getWallet(shop);
  if (!isFreeShop(shop) && wallet.balance < POST_PUBLISH_FEE) {
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
      logActivity({
        shop,
        action: "post_publish",
        detail: `post:${post.id} now platforms:${platforms.join(",")}`,
        feeCharged: isFreeShop(shop) ? 0 : POST_PUBLISH_FEE,
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
  logActivity({
    shop,
    action: "post_schedule",
    detail: `post:${post.id} at:${scheduledAt.toISOString()} platforms:${platforms.join(",")}`,
    feeCharged: isFreeShop(shop) ? 0 : POST_PUBLISH_FEE,
  });

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

  // AI caption generator state
  const [aiTopic, setAiTopic] = useState("");
  const [aiTone, setAiTone] = useState("Professional");
  const [aiObjective, setAiObjective] = useState("awareness");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");

  // AI image generator state
  const [imgPrompt, setImgPrompt] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState("");

  // Store catalog picker state
  const [catalog, setCatalog] = useState<{
    products: Array<{ id: string; title: string; description: string; image: string; price: string }>;
    collections: Array<{ id: string; title: string; description: string; image: string }>;
  } | null>(null);
  const [catalogSource, setCatalogSource] = useState("manual"); // manual | product | collection
  const [catalogChoice, setCatalogChoice] = useState("");

  const loadCatalog = async () => {
    if (catalog) return;
    try {
      const res = await fetch("/api/shop/catalog");
      const data = (await res.json()) as {
        products?: Array<{ id: string; title: string; description: string; image: string; price: string }>;
        collections?: Array<{ id: string; title: string; description: string; image: string }>;
      };
      setCatalog({ products: data.products ?? [], collections: data.collections ?? [] });
    } catch {
      // picker stays empty; merchant can still type manually
    }
  };

  const applyCatalogChoice = (source: string, id: string) => {
    setCatalogSource(source);
    setCatalogChoice(id);
    if (!catalog || !id) return;
    if (source === "product") {
      const p = catalog.products.find((x) => x.id === id);
      if (!p) return;
      const topic = `${p.title}${p.price ? ` — ${p.price}` : ""}${p.description ? `. ${p.description}` : ""}`;
      setAiTopic(topic);
      if (p.image) setMediaUrl(p.image);
      setImgPrompt(`Professional e-commerce product photography of ${p.title}, clean studio background, high quality, commercial style`);
    } else if (source === "collection") {
      const c = catalog.collections.find((x) => x.id === id);
      if (!c) return;
      const topic = `${c.title} collection${c.description ? `. ${c.description}` : ""}`;
      setAiTopic(topic);
      if (c.image) setMediaUrl(c.image);
      setImgPrompt(`Lifestyle promotional image for ${c.title} collection, vibrant, professional e-commerce style`);
    }
  };

  const handleImageGenerate = async () => {
    if (!imgPrompt.trim() || imgBusy) return;
    setImgBusy(true);
    setImgError("");
    // Enrich the image prompt with the selected post goal so the visual matches.
    const goalHint =
      aiObjective === "sales"
        ? ", commercial advertising style, eye-catching, product-focused"
        : ", engaging social media style, vibrant, shareable";
    try {
      const res = await fetch("/api/ai/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: imgPrompt.trim() + goalHint }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        url?: string;
        message?: string;
        error?: string;
      };
      if (!data.ok || !data.url) {
        setImgError(
          data.error === "AI_NOT_CONFIGURED"
            ? "Image generation is unavailable right now — please try again later."
            : data.message || "Image generation failed. Please try again.",
        );
        return;
      }
      setMediaUrl(data.url);
    } catch {
      setImgError("Could not reach the image service. Please try again.");
    } finally {
      setImgBusy(false);
    }
  };

  const handleAiGenerate = async () => {
    if (!aiTopic.trim() || aiBusy) return;
    setAiBusy(true);
    setAiError("");
    try {
      const res = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: aiTopic.trim(),
          platform: platforms[0] ?? "facebook",
          tone: aiTone,
          objective: aiObjective,
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        caption?: string;
        hashtags?: string[];
        message?: string;
        error?: string;
      };
      if (!data.ok) {
        setAiError(
          data.error === "AI_NOT_CONFIGURED"
            ? "Caption writer is unavailable right now — please try again later."
            : data.message || "Caption writing failed. Please try again.",
        );
        return;
      }
      const tags = (data.hashtags ?? []).map((h) => `#${h}`).join(" ");
      const generated = tags ? `${data.caption}\n\n${tags}` : (data.caption ?? "");
      setContent(generated);
    } catch {
      setAiError("Could not reach the caption service. Please try again.");
    } finally {
      setAiBusy(false);
    }
  };

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
              <NavButton url="/app/accounts" variant="primary">
                Go to Accounts
              </NavButton>
            </BlockStack>
          </Card>
        ) : (
          <form onSubmit={handleSubmit}>
            <Layout>
              <Layout.Section>
                <BlockStack gap="500">
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        📦 Post about
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Pick a product or collection from your store — the
                        caption topic and media fill in automatically. Or write
                        manually.
                      </Text>
                      <Select
                        label="Source"
                        options={[
                          { label: "Write manually", value: "manual" },
                          { label: "Store product", value: "product" },
                          { label: "Store collection", value: "collection" },
                        ]}
                        value={catalogSource}
                        onChange={(v) => {
                          loadCatalog();
                          applyCatalogChoice(v, "");
                        }}
                      />
                      {catalogSource !== "manual" && (
                        <Select
                          label={catalogSource === "product" ? "Product" : "Collection"}
                          options={[
                            { label: "Choose…", value: "" },
                            ...(catalogSource === "product"
                              ? (catalog?.products ?? []).map((p) => ({
                                  label: `${p.title}${p.price ? ` (${p.price})` : ""}`,
                                  value: p.id,
                                }))
                              : (catalog?.collections ?? []).map((c) => ({
                                  label: c.title,
                                  value: c.id,
                                }))),
                          ]}
                          value={catalogChoice}
                          onChange={(v) => applyCatalogChoice(catalogSource, v)}
                        />
                      )}
                    </BlockStack>
                  </Card>
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        ✨ Caption writer
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Describe your post and get a ready-to-post caption +
                        hashtags. You can edit it before publishing. $0.20 per
                        generation.
                      </Text>
                      <FormLayout>
                        <TextField
                          label="What is the post about?"
                          value={aiTopic}
                          onChange={setAiTopic}
                          placeholder="e.g. new summer dress collection, 20% launch offer"
                          autoComplete="off"
                        />
                        <Select
                          label="Tone"
                          options={[
                            { label: "Professional", value: "Professional" },
                            { label: "Funny", value: "Funny" },
                            { label: "Casual", value: "Casual" },
                          ]}
                          value={aiTone}
                          onChange={setAiTone}
                        />
                        <Select
                          label="Post goal"
                          options={[
                            { label: "Awareness — engage & grow audience", value: "awareness" },
                            { label: "Sales — convert & drive purchases", value: "sales" },
                          ]}
                          value={aiObjective}
                          onChange={setAiObjective}
                          helpText="The AI writes the caption to match your goal."
                        />
                      </FormLayout>
                      {aiError && <Banner tone="critical">{aiError}</Banner>}
                      <Button
                        variant="secondary"
                        onClick={handleAiGenerate}
                        loading={aiBusy}
                        disabled={aiBusy || !aiTopic.trim()}
                        fullWidth
                      >
                        {aiBusy ? "Writing…" : "Write my caption ($0.20)"}
                      </Button>
                    </BlockStack>
                  </Card>
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
                          helpText="Paste a direct link to an image or video file — or generate one below."
                          autoComplete="off"
                        />
                        {mediaUrl && (
                          <img
                            src={mediaUrl}
                            alt="Post media preview"
                            style={{
                              maxWidth: "100%",
                              maxHeight: 220,
                              borderRadius: 8,
                              border: "1px solid #e1e3e5",
                            }}
                          />
                        )}
                        <TextField
                          label="Generate an image"
                          value={imgPrompt}
                          onChange={setImgPrompt}
                          placeholder="e.g. a happy dog wearing sunglasses on a beach at sunset"
                          autoComplete="off"
                        />
                        {imgError && <Banner tone="critical">{imgError}</Banner>}
                        <Button
                          variant="secondary"
                          onClick={handleImageGenerate}
                          loading={imgBusy}
                          disabled={imgBusy || !imgPrompt.trim()}
                          fullWidth
                        >
                          {imgBusy ? "Generating…" : "Generate image ($0.40)"}
                        </Button>
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
