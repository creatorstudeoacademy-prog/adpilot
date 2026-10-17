import { Outlet } from "@remix-run/react";

/**
 * Layout for /app/ads/* — child routes (create, campaigns, audiences,
 * funnel, connect) render here. The dashboard itself lives in
 * app.ads._index.tsx.
 */
export default function AdsLayout() {
  return <Outlet />;
}
