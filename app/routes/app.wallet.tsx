import { Outlet } from "@remix-run/react";

/**
 * Layout for /app/wallet/* — child routes (topup) render here.
 * The wallet dashboard itself lives in app.wallet._index.tsx.
 */
export default function WalletLayout() {
  return <Outlet />;
}
