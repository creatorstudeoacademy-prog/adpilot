import { useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Grid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SCHEDULE_PACKAGES, TEXT_POST_FEE } from "../lib/pricing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const accounts = await prisma.socialAccount.findMany({
    where: { shop: session.shop },
    select: { id: true, pageName: true },
  });
  return json({
    accounts,
    packages: SCHEDULE_PACKAGES,
    perPostFee: TEXT_POST_FEE,
  });
};

interface Draft {
  date: string;
  time: string;
  content: string;
}

type Step = 1 | 2 | 3;

const GOAL_OPTIONS = [
  { label: "Increase Sales", value: "Increase Sales" },
  { label: "Brand Awareness", value: "Brand Awareness" },
  { label: "Boost Engagement", value: "Boost Engagement" },
  { label: "Drive Website Traffic", value: "Drive Website Traffic" },
  { label: "Product Launch", value: "Product Launch" },
  { label: "Seasonal Promotion", value: "Seasonal Promotion" },
  { label: "Customer Reviews & Trust", value: "Customer Reviews & Trust" },
  { label: "Custom…", value: "__custom" },
];

export default function ScheduleSetup() {
  const { accounts, packages, perPostFee } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [goal, setGoal] = useState(GOAL_OPTIONS[0].value);
  const [customGoal, setCustomGoal] = useState("");
  const [topic, setTopic] = useState("");
  const [suggestedTopics, setSuggestedTopics] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [startDate, setStartDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [postTime, setPostTime] = useState("09:00");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pkg = packages.find((p) => p.id === packageId);

  const effectiveGoal = goal === "__custom" ? customGoal.trim() : goal;

  const suggestTopics = async () => {
    if (!effectiveGoal) {
      setError("Pick a goal first.");
      return;
    }
    setError(null);
    setSuggesting(true);
    try {
      const res = await fetch("/api/schedule/suggest-topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: effectiveGoal }),
      });
      const data = (await res.json()) as { ok: boolean; topics?: string[]; message?: string };
      if (data.ok && data.topics) {
        setSuggestedTopics(data.topics);
      } else {
        setError(data.message || "Couldn't suggest topics.");
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setSuggesting(false);
    }
  };

  const generate = async () => {
    if (!effectiveGoal || !topic.trim() || !accountId) {
      setError("Please pick a goal, enter a topic, and select a page.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/schedule/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId, goal: effectiveGoal, topic, startDate }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        posts?: Draft[];
        message?: string;
      };
      if (data.ok && data.posts) {
        setDrafts(data.posts.map((p) => ({ ...p, time: postTime })));
        setStep(3);
      } else {
        setError(data.message || "Couldn't generate posts.");
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    const valid = drafts.filter((d) => d.content.trim());
    if (valid.length === 0) {
      setError("Add at least one post.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/schedule/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId, accountId, posts: valid }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      if (data.ok) {
        navigate("/app/scheduled");
      } else {
        setError(data.message || "Couldn't schedule posts.");
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = (i: number, field: keyof Draft, value: string) => {
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, [field]: value } : d)));
  };
  const removeDraft = (i: number) => {
    setDrafts((ds) => ds.filter((_, j) => j !== i));
  };

  return (
    <Page
      title="Auto-schedule setup"
      subtitle="Pick a package, tell us your goal — AI writes your posts"
      backAction={{ content: "Posts", url: "/app/scheduled" }}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        {/* STEP 1 — package */}
        {step === 1 && (
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Step 1 — Choose your package
            </Text>
            <Grid>
              {packages.map((p) => (
                <Grid.Cell key={p.id} columnSpan={{ xs: 6, sm: 2, md: 2, lg: 4, xl: 4 }}>
                  <div
                    onClick={() => setPackageId(p.id)}
                    style={{ cursor: "pointer", height: "100%" }}
                  >
                    <Card>
                      <Box
                        padding="400"
                        background={packageId === p.id ? "bg-surface-selected" : undefined}
                      >
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingMd">
                            {p.label}
                          </Text>
                          <Text as="p" variant="heading2xl">
                            ${p.fee.toFixed(2)}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {p.posts} posts · {p.days} days
                          </Text>
                          {packageId === p.id && (
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              ✓ Selected
                            </Text>
                          )}
                        </BlockStack>
                      </Box>
                    </Card>
                  </div>
                </Grid.Cell>
              ))}
            </Grid>
            <InlineStack align="end">
              <Button variant="primary" onClick={() => setStep(2)}>
                Continue
              </Button>
            </InlineStack>
          </BlockStack>
        )}

        {/* STEP 2 — goal & topic */}
        {step === 2 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Step 2 — Your goal & topic
                </Text>
                <Select
                  label="Facebook Page"
                  options={accounts.map((a) => ({ label: a.pageName, value: a.id }))}
                  value={accountId}
                  onChange={setAccountId}
                />
                <Select
                  label="Goal"
                  options={GOAL_OPTIONS}
                  value={goal}
                  onChange={(v) => {
                    setGoal(v);
                    setSuggestedTopics([]);
                  }}
                />
                {goal === "__custom" && (
                  <TextField
                    label="Custom goal"
                    value={customGoal}
                    onChange={setCustomGoal}
                    placeholder="e.g. Promote my new skincare line"
                    autoComplete="off"
                  />
                )}
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="medium">
                      Topic
                    </Text>
                    <Button
                      variant="plain"
                      loading={suggesting}
                      onClick={() => void suggestTopics()}
                    >
                      ✨ Suggest topics
                    </Button>
                  </InlineStack>
                  <TextField
                    label="Topic"
                    labelHidden
                    value={topic}
                    onChange={setTopic}
                    placeholder="e.g. Cozy winter fashion, new arrivals"
                    autoComplete="off"
                  />
                  {suggestedTopics.length > 0 && (
                    <InlineStack gap="200">
                      {suggestedTopics.map((t, i) => (
                        <Button key={i} size="slim" onClick={() => setTopic(t)}>
                          {t}
                        </Button>
                      ))}
                    </InlineStack>
                  )}
                </BlockStack>
                <TextField
                  label="Start date"
                  type="date"
                  value={startDate}
                  onChange={setStartDate}
                  autoComplete="off"
                />
                <TextField
                  label="Post time (each day)"
                  type="time"
                  value={postTime}
                  onChange={setPostTime}
                  autoComplete="off"
                  helpText="Same date, different times also allowed — adjust per post in the next step."
                />
                <InlineStack gap="200" align="end">
                  <Button onClick={() => setStep(1)}>Back</Button>
                  <Button variant="primary" loading={busy} onClick={() => void generate()}>
                    Generate {pkg?.posts ?? ""} posts with AI
                  </Button>
                </InlineStack>
              </BlockStack>
            </Box>
          </Card>
        )}

        {/* STEP 3 — review & approve */}
        {step === 3 && (
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Step 3 — Review & approve
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                {pkg?.label} · ${pkg?.fee.toFixed(2)} will be charged on approve
              </Text>
            </InlineStack>
            {drafts.map((d, i) => (
              <Card key={i}>
                <Box padding="400">
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        Day {i + 1} — {d.date}
                      </Text>
                      <Button variant="plain" tone="critical" onClick={() => removeDraft(i)}>
                        Remove
                      </Button>
                    </InlineStack>
                    <TextField
                      label={`Post ${i + 1}`}
                      labelHidden
                      value={d.date}
                      onChange={(v) => updateDraft(i, "date", v)}
                      type="date"
                      autoComplete="off"
                    />
                    <TextField
                      label={`Post ${i + 1} time`}
                      labelHidden
                      value={d.time}
                      onChange={(v) => updateDraft(i, "time", v)}
                      type="time"
                      autoComplete="off"
                    />
                    <TextField
                      label={`Post ${i + 1} content`}
                      labelHidden
                      value={d.content}
                      onChange={(v) => updateDraft(i, "content", v)}
                      multiline={3}
                      autoComplete="off"
                    />
                  </BlockStack>
                </Box>
              </Card>
            ))}
            <Card>
              <Box padding="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd">
                      {drafts.filter((d) => d.content.trim()).length} posts ready
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Charged on approve: ${pkg?.fee.toFixed(2)} (${perPostFee.toFixed(2)}/post
                      value)
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200">
                    <Button onClick={() => setStep(2)}>Back</Button>
                    <Button variant="primary" loading={busy} onClick={() => void approve()}>
                      Approve & schedule
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Box>
            </Card>
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
