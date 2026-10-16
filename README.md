# PixelPro — Multi Pixel Manager

Install Meta (Facebook), TikTok, Google and Snapchat pixels on any Shopify
store from a single dashboard. Paste each pixel ID once; PixelPro fires
PageView, ViewContent, AddToCart, InitiateCheckout and Purchase events
automatically via a theme app embed — no code edits, no theme changes.

## How it works

1. Merchant installs the app and opens **PixelPro** in Shopify admin.
2. Merchant pastes pixel IDs (Meta, TikTok, Google Tag, Snapchat) and saves.
   Settings are stored as JSON in the shop metafield `pixelpro.config`.
3. Merchant enables the **PixelPro Tracking** app embed in the theme editor
   (Theme settings → App embeds).
4. The `pixels.liquid` block injects only the pixels that have IDs configured
   and passes page context (product, cart, order) as JSON to `pixelpro.js`,
   which fires the standard events to each pixel library.

## Plans

- **Free:** Meta Pixel tracking with all standard events.
- **PixelPro — $12.99/month** (7-day free trial, billed via Shopify Billing API):
  unlocks TikTok, Google and Snapchat pixels. Pro-only fields are enforced
  server-side in the settings action, not just hidden in the UI.

## Project structure

- `app/shopify.server.ts` — app init, Prisma session storage, Billing API plan
- `app/lib/settings.server.ts` — metafield read/write (`pixelpro.config`)
- `app/routes/app._index.tsx` — settings UI (Polaris)
- `app/routes/app.billing.tsx` — Free vs PixelPro plan cards, upgrade/downgrade
- `extensions/pixel-pro/` — theme app extension
  - `blocks/pixels.liquid` — app embed: pixel base code + page-context JSON
  - `assets/pixelpro.js` — event layer (PageView, ViewContent, AddToCart,
    InitiateCheckout, Purchase)
- `prisma/schema.prisma` — Session model (OAuth storage only)

## Event coverage

| Event | Meta | TikTok | Google | Snapchat |
|---|---|---|---|---|
| PageView | PageView | page | page_view | PAGE_VIEW |
| ViewContent | ViewContent | ViewContent | view_item | VIEW_CONTENT |
| AddToCart | AddToCart | AddToCart | add_to_cart | ADD_CART |
| InitiateCheckout | InitiateCheckout | InitiateCheckout | begin_checkout | START_CHECKOUT |
| Purchase | Purchase | Purchase | purchase | PURCHASE |

AddToCart is captured from classic form submits plus AJAX (`fetch`/`XHR` to
`/cart/add.js`). Purchase fires once per order (sessionStorage guard) on the
thank-you page.

> **Note — Purchase on non-Plus stores:** theme app embeds do not render on
> the order-status (thank-you) page for non-Shopify-Plus stores, so the
> Purchase event fires there only when the block renders (Plus, or checkout
> extensibility). For reliable Purchase tracking on any plan, merchants can
> paste this into **Settings → Checkout → Order status → Additional scripts**:
>
> ```html
> <!-- PixelPro purchase fallback (order status page) -->
> <script>
>   // Replace with your IDs; fires once per order via Shopify's own guard
>   // (this script runs once per order on first page view).
>   var ORDER_TOTAL = {{ checkout.total_price | divided_by: 100.0 | json }};
>   var ORDER_CURRENCY = {{ shop.currency | json }};
>   var ORDER_ID = {{ checkout.order_id | json }};
>   if (window.fbq) fbq('track', 'Purchase', {value: ORDER_TOTAL, currency: ORDER_CURRENCY});
>   if (window.ttq) ttq.track('Purchase', {value: ORDER_TOTAL, currency: ORDER_CURRENCY});
>   if (window.gtag) gtag('event', 'purchase', {value: ORDER_TOTAL, currency: ORDER_CURRENCY, transaction_id: String(ORDER_ID)});
>   if (window.snaptr) snaptr('track', 'PURCHASE', {price: ORDER_TOTAL, currency: ORDER_CURRENCY, transaction_id: String(ORDER_ID)});
> </script>
> ```
>
> This is optional — PageView, ViewContent, AddToCart and InitiateCheckout
> all work from the app embed alone.

## Deploy

Same pattern as the other apps in `~/workspace/apps/`:

```dockerfile
FROM node:20-slim
# openssl for Prisma, prisma generate + db push, build, remix-serve
```

See `Dockerfile`. Required env vars: `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` (empty — no scopes needed).

## Notes

- The app stores no customer PII; GDPR webhooks acknowledge receipt.
- All pixel calls are wrapped defensively — a failing pixel can never break
  the storefront.
- Dev stores cannot create real subscriptions; billing is verified on a live
  store.
