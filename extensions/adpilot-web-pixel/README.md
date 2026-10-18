# AdPilot Web Pixel

Fires Meta Pixel events (PageView, ViewContent, AddToCart, InitiateCheckout,
AddPaymentInfo, Purchase) on the merchant's storefront. This gives the
"website audiences" and Sales-campaign conversion tracking a real data source.

## Deploy

```bash
cd ~/workspace/apps/adpilot
shopify app deploy
```

This registers the `adpilot-web-pixel` web pixel extension with Shopify.

## Merchant setup (one-time)

1. In the Shopify admin: **Online Store > Themes > Customize > App embeds**
2. Enable **AdPilot web pixel**
3. Paste the Meta Pixel ID (the same one saved in AdPilot > Accounts)

The pixel ID is stored in the extension settings — no code changes needed
per merchant.

## Notes

- Web pixels run in Shopify's sandbox; they cannot read app metafields,
  which is why the pixel ID lives in extension settings.
- Test events: use Meta Events Manager > Test Events while browsing the
  storefront.
- The "Send test event" button in AdPilot > Create campaign verifies the
  pixel ID is valid before the merchant enables this.
