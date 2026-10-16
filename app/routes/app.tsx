import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const adminShop = (process.env.ADMIN_SHOP_DOMAIN ?? "").trim();

  return json({
    apiKey: process.env.SHOPIFY_API_KEY || "",
    isAdmin: Boolean(adminShop) && session.shop === adminShop,
  });
};

export default function App() {
  const { apiKey, isAdmin } = useLoaderData<typeof loader>();
  // On the admin page the owner wants a pure control panel — hide merchant nav.
  const onAdminPage = useLocation().pathname.startsWith("/app/admin");

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        {onAdminPage && isAdmin ? (
          <>
            <Link to="/app" rel="home">
              Dashboard
            </Link>
            <Link to="/app/admin">AI Control Panel</Link>
          </>
        ) : (
          <>
            <Link to="/app" rel="home">
              Dashboard
            </Link>
            <Link to="/app/accounts">Accounts</Link>
            <Link to="/app/compose">Compose</Link>
            <Link to="/app/scheduled">Scheduled</Link>
            <Link to="/app/ads">Ads</Link>
            <Link to="/app/ads/funnel">Full Funnel</Link>
            <Link to="/app/ads/audiences">Audiences</Link>
            <Link to="/app/wallet">Wallet</Link>
            <Link to="/app/billing">Pricing</Link>
            {isAdmin && <Link to="/app/admin">AI Control Panel</Link>}
          </>
        )}
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
