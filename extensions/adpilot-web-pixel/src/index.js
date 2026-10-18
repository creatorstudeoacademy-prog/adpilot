/**
 * AdPilot web pixel — fires Meta Pixel events on the storefront AND
 * streams a copy to AdPilot for the live event feed + data-quality filters.
 *
 * Settings (Theme editor > App embeds > AdPilot web pixel):
 * - pixel_id: the Meta Pixel ID
 * - app_url: the AdPilot app URL (for the live event stream)
 * - shop: the store's myshopify.com domain
 *
 * Deploy: `shopify app deploy` (then enable the pixel in Theme editor).
 */

const PIXEL_ID = "{{ settings.pixel_id }}";
const APP_URL = "{{ settings.app_url }}";
const SHOP = "{{ settings.shop }}";

function newEventId() {
  return "evt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

// Stream a copy of every event to AdPilot (live feed + filters).
function streamToAdPilot(eventName, params) {
  if (!APP_URL || !SHOP) return;
  try {
    const body = {
      shop: SHOP,
      pixelId: PIXEL_ID,
      eventName: eventName,
      eventId: newEventId(),
      url: params.pageUrl || "",
      value: params.value,
      currency: params.currency,
      contentIds: params.content_ids,
    };
    fetch(APP_URL.replace(/\/$/, "") + "/api/pixel/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(function () {});
  } catch (e) {}
}

function track(eventName, params) {
  params = params || {};
  if (typeof fbq === "function") {
    fbq("track", eventName, params);
  }
  streamToAdPilot(eventName, params);
}

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
  track("PageView", { pageUrl: (typeof location !== "undefined" && location.href) || "" });

  // Standard Shopify pixel events -> Meta standard events (+ AdPilot stream).
  analytics.subscribe("page_viewed", function (event) {
    track("PageView", { pageUrl: event.context?.document?.location?.href || "" });
  });
  analytics.subscribe("product_viewed", function (event) {
    var p = event.data?.productVariant || {};
    track("ViewContent", {
      content_ids: [String(p.product?.id ?? p.id ?? "")],
      content_type: "product",
      value: p.price?.amount,
      currency: p.price?.currencyCode,
      pageUrl: event.context?.document?.location?.href || "",
    });
  });
  analytics.subscribe("product_added_to_cart", function (event) {
    var p = event.data?.cartLine?.merchandise || {};
    track("AddToCart", {
      content_ids: [String(p.product?.id ?? p.id ?? "")],
      content_type: "product",
      value: p.price?.amount,
      currency: p.price?.currencyCode,
      pageUrl: event.context?.document?.location?.href || "",
    });
  });
  analytics.subscribe("checkout_started", function (event) {
    track("InitiateCheckout", {
      value: event.data?.checkout?.totalPrice?.amount,
      currency: event.data?.checkout?.totalPrice?.currencyCode,
      pageUrl: event.context?.document?.location?.href || "",
    });
  });
  analytics.subscribe("payment_info_submitted", function (event) {
    track("AddPaymentInfo", {
      value: event.data?.checkout?.totalPrice?.amount,
      currency: event.data?.checkout?.totalPrice?.currencyCode,
    });
  });
  analytics.subscribe("checkout_completed", function (event) {
    track("Purchase", {
      value: event.data?.checkout?.totalPrice?.amount,
      currency: event.data?.checkout?.totalPrice?.currencyCode,
    });
  });
}
