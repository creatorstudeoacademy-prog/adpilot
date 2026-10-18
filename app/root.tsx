import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import type { LinksFunction } from "@remix-run/node";

import adpilotStyles from "./styles/adpilot-ui.css?url";
import adpilot3dStyles from "./styles/adpilot-3d.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: adpilotStyles },
  { rel: "stylesheet", href: adpilot3dStyles },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
