# AdPilot Pixel Intelligence — Roadmap

> Goal: give every merchant an ad-expert-level pixel setup — live data they can
> watch, pure signal Meta can optimize on, and AI that turns the data into sales.
> No wasted budget, no guesswork.

## ✅ Phase 1 — LIVE NOW (shipped)

**Live data pipe (Shop → AdPilot → Meta)**
- Web pixel extension streams every storefront event to AdPilot AND Meta in parallel.
- `POST /api/pixel/collect` receives browser events, applies filters, stores them.
- Test events (from the Accounts page tester) are logged to the same feed.

**📡 Pixel Live Hub (Accounts page, per connected pixel — no click needed)**
- Auto-shows live data for the CONNECTED pixel only.
- Animated live event stream (5s polling, new events slide in with a pulse).
- Connection visualization: Your store → AdPilot filters → Meta.
- "Last event" recency indicator.

**🧹 Pure-data filters (per shop, toggleable)**
- Deduplicate browser + server double-fires (shared event_id, 60s window).
- Block bot & crawler traffic.
- Scrub PII (emails, phone numbers) from URLs.
- Require value + currency on purchase-type events (protects ROAS accuracy).
- Exclude staff traffic by IP.

**Health + tester**
- 🩺 Pixel health analysis (AI report: score, strengths, weaknesses, fixes).
- Event tester: PageView → Purchase, verified in Meta Events Manager via test code.

## 🔜 Phase 2 — Customer journey (next)

- **Session view**: group live events by visitor session — see the path
  (Home → Product → AddToCart → Checkout → Purchase) per visitor, live.
- **Click tracking**: record what visitors click (product cards, CTAs, nav)
  via the web pixel; show top-clicked elements per page.
- **Drop-off funnel**: PageView → ViewContent → AddToCart → InitiateCheckout →
  Purchase, computed live from the event stream; AI flags the leakiest step.
- **AI event analyst**: "Why did purchases drop this week?" — AI reads the
  live + historical events and answers in plain language.

## 🔮 Phase 3 — Signal intelligence (later)

- **Server-side (CAPI) relay**: AdPilot forwards filtered browser events to
  Meta server-side with matching event_ids — full redundancy, iOS-proof.
- **Event Match Quality coach**: AI suggestions to raise match quality
  (which parameters are missing, per event type).
- **Smart alerts**: "Purchase events stopped 2h ago" / "AddToCart spiked 3x" —
  push + in-app.
- **Benchmarks**: anonymized, opt-in — "stores like yours get 2.1% AddToCart rate".

## 🔧 Reliability work (ongoing)

- Token health monitor: warn before the Meta user token expires; one-click reconnect.
- Collector redundancy: if the live feed endpoint is down, events queue in the
  web pixel and retry (no data loss).
- Daily pixel heartbeat: background check that each connected pixel fired in
  the last 24h; alert the merchant if silent.

## Notes / constraints

- Meta has NO public API to read live pixel events — the live feed works
  because AdPilot's own web pixel streams a copy. Events fired by OTHER pixels
  or native integrations won't appear.
- The web pixel extension needs `shopify app deploy` + merchant enables it in
  Theme editor → App embeds.
- Catalog / insights features unlock after Meta App Review approval.
