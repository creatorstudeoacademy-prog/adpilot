/**
 * AdPilot web pixel — fires Meta Pixel events on the storefront.
 *
 * The merchant's Meta Pixel ID comes from the extension settings
 * (Theme editor > App embeds > AdPilot web pixel), which AdPilot
 * pre-fills from the pixel saved in Accounts.
 *
 * Deploy: `shopify app deploy` (then enable the pixel in Theme editor).
 */

// The pixel ID is injected from extension settings at deploy/runtime.
const PIXEL_ID = "{{ settings.pixel_id }}";

if (PIXEL_ID && /^\d+$/.test(PIXEL_ID)) {
  // Load Meta's fbevents.js inside the sandbox.
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = "2.0";
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(
    window,
    document,
    "script",
    "https://connect.facebook.net/en_US/fbevents.js",
  );

  fbq("init", PIXEL_ID);
  fbq("track", "PageView");

  // Standard Shopify pixel events -> Meta standard events.
  analytics.subscribe("page_viewed", () => fbq("track", "PageView"));
  analytics.subscribe("product_viewed", (event) => {
    const p = event.data?.productVariant || {};
    fbq("track", "ViewContent", {
      content_ids: [String(p.product?.id ?? p.id ?? "")],
      content_type: "product",
      value: p.price?.amount,
      currency: p.price?.currencyCode,
    });
  });
  analytics.subscribe("product_added_to_cart", (event) => {
    const p = event.data?.cartLine?.merchandise || {};
    fbq("track", "AddToCart", {
      content_ids: [String(p.product?.id ?? p.id ?? "")],
      content_type: "product",
      value: p.price?.amount,
      currency: p.price?.currencyCode,
    });
  });
  analytics.subscribe("checkout_started", (event) => {
    fbq("track", "InitiateCheckout", {
      value: event.data?.checkout?.totalPrice?.amount,
      currency: event.data?.checkout?.totalPrice?.currencyCode,
    });
  });
  analytics.subscribe("payment_info_submitted", (event) => {
    fbq("track", "AddPaymentInfo", {
      value: event.data?.checkout?.totalPrice?.amount,
      currency: event.data?.checkout?.totalPrice?.currencyCode,
    });
  });
  analytics.subscribe("checkout_completed", (event) => {
    fbq("track", "Purchase", {
      value: event.data?.checkout?.totalPrice?.amount,
      currency: event.data?.checkout?.totalPrice?.currencyCode,
    });
  });
}
