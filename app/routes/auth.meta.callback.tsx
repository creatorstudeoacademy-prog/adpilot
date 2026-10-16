import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";
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
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!appId || !appSecret || !appUrl) {
    throw new Response("Meta app credentials are not configured.", {
      status: 500,
    });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    return redirect("/app/accounts?meta_error=denied");
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
    return redirect("/app/accounts?meta_error=token");
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
    return redirect("/app/accounts?meta_error=pages");
  }
  const pagesData = (await pagesRes.json()) as PagesResponse;

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

  return redirect("/app/accounts?connected=1");
};
