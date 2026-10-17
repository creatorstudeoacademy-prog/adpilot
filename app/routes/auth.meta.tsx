import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import {
  encodeMetaState,
  verifyMetaConnectParams,
} from "../lib/meta-oauth.server";

const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "ads_read",
  "ads_management",
].join(",");

/**
 * Starts the Facebook OAuth flow.
 *
 * Runs in a top-level browser tab (Facebook blocks iframes), so it does NOT
 * use shopify.authenticate.admin() — there is no Shopify session in a fresh
 * tab. Instead it verifies the HMAC-signed params minted by the Accounts page
 * loader (which runs with a valid admin session).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = verifyMetaConnectParams(url.searchParams);
  if (!shop) {
    throw new Response(
      "This Facebook connect link is invalid or has expired. Please go back to the Accounts page in Shopify admin and click Connect Facebook again.",
      { status: 403 },
    );
  }

  const appId = process.env.META_APP_ID;
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!appId || !appUrl) {
    throw new Response(
      "Meta app credentials are not configured. Set META_APP_ID and META_APP_SECRET.",
      { status: 500 },
    );
  }

  const redirectUri = `${appUrl}/auth/meta/callback`;
  // Carry the signed bundle through `state` so the callback can verify it.
  const state = encodeMetaState(
    shop,
    url.searchParams.get("ts") ?? "",
    url.searchParams.get("sig") ?? "",
  );

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: META_SCOPES,
    response_type: "code",
    state,
  });

  return redirect(`https://www.facebook.com/v21.0/dialog/oauth?${params}`);
};
