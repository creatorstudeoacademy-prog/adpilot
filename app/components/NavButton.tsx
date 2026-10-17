import { Button } from "@shopify/polaris";
import type { ButtonProps } from "@shopify/polaris";
import { useNavigate } from "@remix-run/react";

/**
 * Polaris Button that navigates inside the embedded app.
 *
 * Plain `url` props on Polaris Button do not trigger App Bridge-aware
 * navigation in the Shopify admin iframe (clicks silently do nothing),
 * so this wrapper routes through Remix's useNavigate instead.
 */
export function NavButton({
  url,
  ...props
}: Omit<ButtonProps, "url" | "onClick"> & { url: string }) {
  const navigate = useNavigate();
  return <Button {...props} onClick={() => navigate(url)} />;
}
