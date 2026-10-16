import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { topup } from "../lib/wallet.server";
import { TOPUP_PACKS } from "../lib/pricing";

/**
 * POST /app/wallet/topup — creates a Shopify one-time ApplicationCharge,
 * then redirects the merchant to Shopify's confirmation page.
 * GET /app/wallet/topup?charge_id=... — callback after approval: credits wallet.
 */

const ALLOWED_AMOUNTS = TOPUP_PACKS.map((p) => p.price);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");

  // Callback after the merchant approves the charge in Shopify admin.
  if (chargeId) {
    const response = await admin.graphql(
      `#graphql
      query getCharge($id: ID!) {
        node(id: $id) {
          ... on ApplicationCharge {
            id
            name
            price { amount currencyCode }
            status
          }
        }
      }`,
      { variables: { id: chargeId } },
    );
    const data = await response.json();
    const charge = data?.data?.node;
    if (charge?.status === "ACTIVE") {
      const amount = parseFloat(charge.price.amount);
      const pack = TOPUP_PACKS.find((p) => p.price === Math.round(amount));
      if (pack) {
        const bonus = pack.credit - pack.price;
        await topup(
          shop,
          pack.price,
          `Wallet topup via Shopify — ${charge.name}`,
          chargeId,
          bonus,
        );
      }
      return redirect("/app/wallet?topped=1");
    }
    return redirect("/app/wallet");
  }

  return json({ ok: false });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const amount = Math.round(parseFloat(String(form.get("amount") ?? "0")));

  if (!ALLOWED_AMOUNTS.includes(amount)) {
    return json({ ok: false, error: "Invalid topup amount." });
  }

  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const returnUrl = `${appUrl}/app/wallet/topup`;

  const response = await admin.graphql(
    `#graphql
    mutation createCharge($name: String!, $price: MoneyInput!, $returnUrl: URL!) {
      appPurchaseOneTimeCreate(
        name: $name
        price: $price
        returnUrl: $returnUrl
        test: ${process.env.NODE_ENV !== "production"}
      ) {
        appPurchaseOneTime { id }
        confirmationUrl
        userErrors { field message }
      }
    }`,
    {
      variables: {
        name: `AdPilot wallet topup $${amount}`,
        price: { amount: amount.toFixed(2), currencyCode: "USD" },
        returnUrl,
      },
    },
  );

  const data = await response.json();
  const result = data?.data?.appPurchaseOneTimeCreate;
  const errors = result?.userErrors ?? [];
  if (errors.length > 0 || !result?.confirmationUrl) {
    return json({
      ok: false,
      error: errors.map((e: any) => e.message).join(", ") || "Could not create charge.",
    });
  }

  // Redirect the merchant (top-level) to Shopify's confirmation page.
  return redirect(result.confirmationUrl);
};
