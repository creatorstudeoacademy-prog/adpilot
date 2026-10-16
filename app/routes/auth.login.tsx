import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../shopify.server";

/**
 * Shopify login page for top-level (non-embedded) flows, e.g. the Facebook
 * OAuth flow opened via target="_blank" from the Accounts page.
 * Without this route, /auth/login falls through to auth.$.tsx and crashes.
 * Plain HTML — no AppProvider out here.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Throws a redirect to the Shopify OAuth flow when ?shop= is present.
  const errors = await login(request);
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  return json({ errors, shop });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = await login(request);
  return json({ errors, shop: "" });
};

const ERROR_TEXT: Record<string, string> = {
  missing_shop: "Enter your shop domain.",
  invalid_shop: "That shop domain does not look valid.",
};

export default function Login() {
  const { errors, shop } = useLoaderData<typeof loader>();
  const shopError = (errors as Record<string, string> | undefined)?.shop;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Log in — AdPilot</title>
      </head>
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          margin: 0,
          background: "#f6f6f7",
        }}
      >
        <div
          style={{
            background: "#fff",
            borderRadius: 12,
            padding: "40px 48px",
            maxWidth: 400,
            width: "100%",
            boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
          }}
        >
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Log in to AdPilot</h1>
          <p style={{ fontSize: 14, color: "#5c5f62", margin: "0 0 20px" }}>
            Enter your shop domain to continue connecting Facebook.
          </p>
          <Form method="post">
            <label
              style={{ display: "block", fontSize: 14, marginBottom: 6 }}
              htmlFor="shop"
            >
              Shop domain
            </label>
            <input
              id="shop"
              name="shop"
              defaultValue={shop}
              placeholder="my-shop.myshopify.com"
              autoComplete="off"
              style={{
                width: "100%",
                boxSizing: "border-box",
                fontSize: 15,
                padding: "10px 12px",
                border: "1px solid #c9cccf",
                borderRadius: 8,
                marginBottom: 8,
              }}
            />
            {shopError && (
              <p style={{ fontSize: 13, color: "#d72c0d", margin: "0 0 8px" }}>
                {ERROR_TEXT[shopError] ?? "Login failed. Try again."}
              </p>
            )}
            <button
              type="submit"
              style={{
                width: "100%",
                fontSize: 15,
                fontWeight: 600,
                padding: "10px 12px",
                border: 0,
                borderRadius: 8,
                background: "#008060",
                color: "#fff",
                cursor: "pointer",
                marginTop: 8,
              }}
            >
              Log in
            </button>
          </Form>
        </div>
      </body>
    </html>
  );
}
