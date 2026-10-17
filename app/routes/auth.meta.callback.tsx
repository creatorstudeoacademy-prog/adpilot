import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { verifyMetaState } from "../lib/meta-oauth.server";
import prisma from "../db.server";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface PagesResponse {
  data: Array<{
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string };
  }>;
}

/**
 * Handles the Facebook OAuth callback:
 * 1. Exchanges the code for a user access token.
 * 2. Fetches the user's Facebook Pages.
 * 3. Stores each Page (with its Page token + linked Instagram ID) as a SocialAccount.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // The callback also runs top-level (from Facebook) with no Shopify session —
  // verify the signed `state` minted at flow start instead.
  const shop = verifyMetaState(url.searchParams.get("state"));
  if (!shop) {
    return json({
      ok: false,
      error: "invalid_state",
      message:
        "This Facebook connect session is invalid or has expired. Please start again from the Accounts page.",
    });
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!appId || !appSecret || !appUrl) {
    throw new Response("Meta app credentials are not configured.", {
      status: 500,
    });
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    return json({ ok: false, error: "denied" });
  }

  const redirectUri = `${appUrl}/auth/meta/callback`;

  // 1. Exchange code for a short-lived user token.
  const tokenRes = await fetch(
    `https://graph.facebook.com/v21.0/oauth/access_token?` +
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      }),
  );
  if (!tokenRes.ok) {
    console.error("Meta token exchange failed:", await tokenRes.text());
    return json({ ok: false, error: "token" });
  }
  const tokenData = (await tokenRes.json()) as TokenResponse;

  // 2. Upgrade to a long-lived user token (60 days).
  let userToken = tokenData.access_token;
  try {
    const llRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?` +
        new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: userToken,
        }),
    );
    if (llRes.ok) {
      const llData = (await llRes.json()) as TokenResponse;
      userToken = llData.access_token;
    }
  } catch {
    // Fall back to the short-lived token.
  }

  // 3. Get the user's Pages (with Page tokens + linked IG accounts).
  const pagesRes = await fetch(
    `https://graph.facebook.com/v21.0/me/accounts?` +
      new URLSearchParams({
        access_token: userToken,
        fields: "id,name,access_token,instagram_business_account",
      }),
  );
  if (!pagesRes.ok) {
    console.error("Meta pages fetch failed:", await pagesRes.text());
    return json({ ok: false, error: "pages" });
  }
  const pagesData = (await pagesRes.json()) as PagesResponse;

  // 3b. Store the long-lived user token — required for Marketing API
  // (ad accounts). Page tokens cannot call /me/adaccounts.
  await prisma.metaUserToken.upsert({
    where: { shop },
    update: { accessToken: userToken },
    create: { shop, accessToken: userToken },
  });

  // 4. Store each Page.
  for (const page of pagesData.data ?? []) {
    // Page tokens don't expire for most cases; store without expiry.
    await prisma.socialAccount.upsert({
      where: { shop_pageId: { shop, pageId: page.id } },
      update: {
        pageName: page.name,
        accessToken: page.access_token,
        instagramId: page.instagram_business_account?.id ?? null,
      },
      create: {
        shop,
        platform: "facebook",
        pageId: page.id,
        pageName: page.name,
        accessToken: page.access_token,
        instagramId: page.instagram_business_account?.id ?? null,
      },
    });

    // Also create a companion Instagram record if linked.
    if (page.instagram_business_account?.id) {
      await prisma.socialAccount.upsert({
        where: {
          shop_pageId: {
            shop,
            pageId: `ig_${page.instagram_business_account.id}`,
          },
        },
        update: {
          pageName: `${page.name} (Instagram)`,
          accessToken: page.access_token,
          instagramId: page.instagram_business_account.id,
        },
        create: {
          shop,
          platform: "instagram",
          pageId: `ig_${page.instagram_business_account.id}`,
          pageName: `${page.name} (Instagram)`,
          accessToken: page.access_token,
          instagramId: page.instagram_business_account.id,
        },
      });
    }
  }

  const connectedPages = pagesData.data ?? [];
  return json({ ok: true, pages: connectedPages.length });
};

/**
 * The OAuth flow runs in a new browser tab (Facebook blocks iframes), so the
 * callback renders a plain confirmation page instead of redirecting back
 * into the embedded app. Plain HTML — no Shopify AppProvider out here.
 */
export default function MetaCallback() {
  const data = useLoaderData<typeof loader>() as
    | { ok: true; pages: number }
    | { ok: false; error: string; message?: string };

  const ok = data.ok === true;
  const title = ok ? "Facebook connected" : "Connection failed";
  const message = ok
    ? `Connected ${data.pages} Facebook Page${data.pages === 1 ? "" : "s"}. You can close this tab and return to your Shopify admin — your accounts will appear there.`
    : (data as { message?: string }).message ||
      "The Facebook connection did not complete. Close this tab and try again from the Accounts page.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — AdPilot</title>
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
            maxWidth: 440,
            textAlign: "center",
            boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 12 }}>{ok ? "✅" : "⚠️"}</div>
          <h1 style={{ fontSize: 22, margin: "0 0 12px" }}>{title}</h1>
          <p style={{ fontSize: 15, color: "#5c5f62", lineHeight: 1.5 }}>{message}</p>
        </div>
      </body>
    </html>
  );
}
