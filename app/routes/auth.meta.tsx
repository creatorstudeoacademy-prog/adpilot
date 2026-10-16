import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";

const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
].join(",");

/**
 * Starts the Facebook OAuth flow.
 * Requires a Shopify admin session so we know which shop is connecting.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const appId = process.env.META_APP_ID;
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!appId || !appUrl) {
    throw new Response(
      "Meta app credentials are not configured. Set META_APP_ID and META_APP_SECRET.",
      { status: 500 },
    );
  }

  const redirectUri = `${appUrl}/auth/meta/callback`;
  // Pass the shop through `state` so the callback knows who connected.
  const url = new URL(request.url);
  const state = url.searchParams.get("shop") ?? "";

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: META_SCOPES,
    response_type: "code",
    state,
  });

  return redirect(`https://www.facebook.com/v21.0/dialog/oauth?${params}`);
};
