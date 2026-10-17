import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Page,
  RadioButton,
  Text,
} from "@shopify/polaris";
import { useState } from "react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { listAdAccounts } from "../lib/meta-ads.server";
import { NavButton } from "../components/NavButton";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Ad account listing needs the Meta USER token (page tokens cannot call
  // /me/adaccounts). It is stored at connect time in MetaUserToken.
  const userToken = await prisma.metaUserToken.findUnique({ where: { shop } });

  if (!userToken?.accessToken) {
    return json({
      needsMeta: true,
      accounts: [] as Array<{ id: string; name: string; currency: string }>,
      error: null as string | null,
    });
  }

  try {
    const accounts = await listAdAccounts(userToken.accessToken);
    const existing = await prisma.adAccount.findMany({ where: { shop } });
    const existingIds = new Set(existing.map((e) => e.adAccountId));
    return json({
      needsMeta: false,
      accounts: accounts
        .filter((a) => !existingIds.has(a.id.replace("act_", "")))
        .map((a) => ({
          id: a.id.replace("act_", ""),
          name: a.name,
          currency: a.currency,
        })),
      error: null as string | null,
    });
  } catch (e) {
    return json({
      needsMeta: false,
      accounts: [] as Array<{ id: string; name: string; currency: string }>,
      error: e instanceof Error ? e.message : "Could not load ad accounts.",
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const adAccountId = String(form.get("adAccountId") ?? "");
  const adAccountName = String(form.get("adAccountName") ?? "");
  const currency = String(form.get("currency") ?? "USD");

  if (!adAccountId) return json({ ok: false, error: "Pick an ad account." });

  const userToken = await prisma.metaUserToken.findUnique({ where: { shop } });
  if (!userToken?.accessToken)
    return json({ ok: false, error: "Connect Facebook first." });

  await prisma.adAccount.create({
    data: {
      shop,
      adAccountId,
      adAccountName,
      accessToken: userToken.accessToken,
      currency,
    },
  });

  return redirect("/app/ads");
};

export default function ConnectAdAccount() {
  const { needsMeta, accounts, error } = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState("");
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  if (needsMeta) {
    return (
      <Page title="Connect ad account" backAction={{ url: "/app/ads" }}>
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              Connect your Facebook account first — AdPilot uses the same
              Meta connection to find your ad accounts.
            </Text>
            <InlineStack>
              <NavButton variant="primary" url="/app/accounts">
                Connect Facebook
              </NavButton>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  const save = () => {
    const acct = accounts.find((a) => a.id === selected);
    if (!acct) return;
    const data = new FormData();
    data.set("adAccountId", acct.id);
    data.set("adAccountName", acct.name);
    data.set("currency", acct.currency);
    submit(data, { method: "post" });
  };

  return (
    <Page title="Connect ad account" backAction={{ url: "/app/ads" }}>
      <BlockStack gap="500">
        {error && <Banner tone="critical">{error}</Banner>}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Choose an ad account
            </Text>
            {accounts.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No new ad accounts found. Make sure your Meta user has access
                to an ad account in Ads Manager.
              </Text>
            ) : (
              <BlockStack gap="200">
                {accounts.map((a) => (
                  <RadioButton
                    key={a.id}
                    label={`${a.name} (${a.currency})`}
                    checked={selected === a.id}
                    id={a.id}
                    name="adAccount"
                    onChange={() => setSelected(a.id)}
                  />
                ))}
              </BlockStack>
            )}
            <InlineStack>
              <Button
                variant="primary"
                disabled={!selected || busy}
                loading={busy}
                onClick={save}
              >
                Connect selected account
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
