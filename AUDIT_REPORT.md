# AdPilot — Full Codebase Audit Report
**Date:** 2026-10-18 · **Codebase:** `~/workspace/apps/adpilot/` (81 source files)
**Auditors:** main agent + 3 specialist subagents (wallet/billing, scheduler/Meta flows, security)
**Method:** every claim verified against actual code (file + line). No invented issues.

---

## 🔴 CRITICAL — fix before scaling to paying merchants

### C1. Wallet top-up can be credited unlimited times by refreshing the callback URL
- **Files:** `app/routes/app.wallet.topup.tsx:26-90` · `app/lib/wallet.server.ts:50-79`
- **What:** The loader credits the wallet on every load with `?charge_id=...`. It only checks `charge.status === "ACTIVE"` — an ApplicationCharge stays ACTIVE forever. `topup()` never checks whether a `WalletTransaction` with the same `metaRef` (charge ID) already exists.
- **Impact:** Refresh the page 3× after a $90 top-up → $270+ credit from one payment. Direct, unbounded revenue loss.
- **Fix:** Before crediting, check for an existing top-up with the same charge ID and skip:
  ```ts
  const existing = await prisma.walletTransaction.findFirst({
    where: { shop, metaRef: chargeId, type: "topup" },
  });
  if (existing) return redirect("/app/wallet?topped=1");
  ```
  (Insert after the charge-status check, ~line 45.) Consider a unique constraint on `metaRef` for top-ups.

### C2. Lifetime Auto-Post is unwired — merchants pay $40.50–$135 for posting that never happens
- **Files:** `app/routes/api.schedule.lifetime.ts:65-76` · `app/routes/app.scheduled.tsx` (display only)
- **What:** Activate deducts the 3-month fee and creates a `LifetimePackage` row — but **nothing ever generates the daily `ScheduledPost` rows**. `LifetimePackage` is referenced nowhere else in the codebase. The 60s worker only publishes pre-existing posts. Additionally: nothing flips `status` after `endsAt`, and no renewal code exists — so "auto-renews every 3 months" is false, and the stale `active` record makes `activate` return `ALREADY_ACTIVE` forever (merchant can never buy again).
- **Impact:** Paid feature that delivers literally nothing. Chargeback + review risk; also false advertising on auto-renew.
- **Fix:** Either (a) build a daily pass that generates `postsPerDay` AI drafts per active package until `endsAt`, links them via `schedulePackageId`, and implements renewal charging honoring the 3-month lock — or (b) disable the Activate buttons until it exists.

### C3. Funnel "Suggest" buttons crash (500) for every paying merchant
- **Files:** `app/routes/api.ai.suggest-field.ts:15,53` · `app/lib/wallet.server.ts:86`
- **What:** `const FEE = 0`, then for non-free shops it calls `await deduct(shop, 0, ...)` — but `deduct()` throws `"Deduction amount must be positive."` for `amount <= 0`. The funnel's per-box Suggest buttons (advertised FREE) 500 for all paying merchants. Free shops skip the branch, which is why it works on the owner's store.
- **Impact:** A headline feature of the funnel upgrade is broken for 100% of paying users.
- **Fix:** Skip deduct/refund entirely when `FEE === 0`:
  ```ts
  if (!free && FEE > 0) { ...deduct... }
  ```

### C4. `deduct()` balance check is not atomic — concurrent deducts overdraw the wallet
- **Files:** `app/lib/wallet.server.ts:85-108`
- **What:** Reads balance → checks `balance < amount` → decrements in a separate query. Two simultaneous requests (double-clicked Publish, parallel AI calls) both pass the check, then both decrement. SQLite serializes the writes but the check isn't atomic.
- **Impact:** Balance goes negative; merchants spend credit they never bought.
- **Fix:** Single conditional write:
  ```ts
  const updated = await prisma.wallet.updateMany({
    where: { id: wallet.id, balance: { gte: amount } },
    data: { balance: { decrement: amount } },
  });
  if (updated.count === 0) throw new Error("Insufficient wallet balance...");
  ```
  Wrap the wallet update + transaction row in `prisma.$transaction`.

---

## 🟠 HIGH

### H1. Privacy compliance webhooks misconfigured — erasure requests delete nothing
- **Files:** `shopify.app.toml` (compliance_topics → single `uri = "/webhooks/customers/data_request"`) · `app/routes/webhooks.customers.data_request.tsx`
- **What:** All three mandatory topics (`customers/data_request`, `customers/redact`, `shop/redact`) route to the `data_request` handler, which never branches on `topic` — it's a no-op. The real redact handlers (`webhooks.customers.redact.tsx`, `webhooks.shop.redact.tsx`) exist but are **unreachable**.
- **Impact:** GDPR/CCPA violation; Shopify App Store review flag (privacy webhooks are mandatory and checked). A merchant's erasure request deletes zero sessions, zero Meta tokens, zero wallets.
- **Fix:** One `[[webhooks.subscriptions]]` per compliance topic in the toml, or branch on `topic` inside the handler and delegate to the existing redact logic. Test each topic with a signed delivery.

### H2. Fail-open admin guards in 3 of 5 admin APIs
- **Files:** `app/routes/api.admin.coupon-requests.ts` · `api.admin.create-coupon.ts` · `api.admin.seed-coupons.ts`
- **What:** Guards use `if (ADMIN_SHOP && shop !== ADMIN_SHOP)` — if `ADMIN_SHOP_DOMAIN` is ever empty/unset, the check is skipped entirely and **any authenticated shop** can create/send coupons and read all coupon requests. (`app.admin.tsx`, `api.admin.ai-test.ts` correctly fail closed.)
- **Impact:** One unset env var = full admin exposure.
- **Fix:** Fail closed everywhere: `if (!ADMIN_SHOP || shop !== ADMIN_SHOP) throw new Response("Not found", { status: 404 });`

### H3. Meta OAuth tokens stored in plaintext in SQLite
- **Files:** `prisma/schema.prisma` (`SocialAccount.accessToken`, `MetaUserToken.accessToken`, `AdAccount.accessToken`) · writers `app/routes/auth.meta.callback.tsx`, `app.accounts.tsx` (manual token)
- **What:** Tokens with `ads_management` / `pages_manage_posts` (full publish + ad-spend power) are stored verbatim. The app already has AES-256-GCM encryption for AI keys (`ai-providers.server.ts`) but didn't apply it here. A volume-backup leak or DB exposure yields live tokens for every shop. Compounds H1 (redact doesn't delete them either).
- **Impact:** Credential breach = attacker can publish ads and spend on merchants' ad accounts.
- **Fix:** Reuse the existing vault `encrypt`/`decrypt` for all three token columns (encrypt on write, decrypt at read sites in `meta.server.ts`, `scheduler.server.ts`, `app.accounts.tsx`, `api.ai.analyze-campaign.ts`); then rotate existing tokens.

### H4. Compose page says "$0.50" but charges $0.20
- **Files:** `app/routes/app.compose.tsx:711-717` ("Publish now ($0.50)", "$0.50 will be deducted") · `app/routes/app._index.tsx:333` ("$0.50/post") vs `POST_PUBLISH_FEE = 0.20` (`app/lib/pricing.ts:6`)
- **Impact:** Merchants think posting costs 2.5× the real price — suppresses usage. (Billing page shows the correct $0.20.)
- **Fix:** Display the real fee. Per the pricing model (text $0.20 / photo $0.35 / video $0.50), either show `POST_PUBLISH_FEE` dynamically or make the backend charge per media type (`TEXT_POST_FEE`/`PHOTO_POST_FEE`/`VIDEO_POST_FEE`) and display the matching amount.

### H5. Funnel partial failure: full $10.50 charged, partial delivery, no retry
- **Files:** `app/routes/app.ads.funnel.tsx:246-270`
- **What:** If 1–2 of 3 stages succeed (`status === "partial"`), the merchant keeps the full charge with no way to retry the failed stages.
- **Impact:** Paid-for stages never delivered; refund/chargeback risk.
- **Fix:** Add "Retry failed stages" (no re-charge), or pro-rate the fee per stage ($3.50/stage).

### H6. Draft / failed campaigns: no Edit, no Retry-publish — only Delete
- **Files:** `app/routes/app.ads.campaigns.tsx:265-272`
- **What:** Failed campaigns (very common right now — Meta code 3 until App Review approval) can't be retried; the merchant must rebuild from scratch and pay again.
- **Impact:** Wasted effort + double fees; peak frustration during the current review window.
- **Fix:** "Retry publish" for `failed` (re-run Meta publish; fee was refunded, so re-deduct is fair) and "Edit" for `draft` (load back into `/app/ads/create`).

### H7. Campaigns page loader hits the Meta API on every load, per ad account
- **Files:** `app/routes/app.ads.campaigns.tsx:53-80`
- **What:** `Promise.all(adAccounts.map(... getCampaigns ...))` runs live Graph API calls inside the loader on every page visit.
- **Impact:** Slow loads; Meta rate-limit burn (painful while the 500-call Marketing API tier is pending); one expired token errors the whole page.
- **Fix:** Cache Meta campaign lists server-side (5-min TTL), render from cache, refresh via explicit "Refresh" button or background job.

### H8. Unpaid scheduled post gets published for free
- **Files:** `app/routes/app.compose.tsx:182-196`
- **What:** Schedule path creates the post (`status: "scheduled"`) BEFORE `deduct()`. If deduct throws, the post stays scheduled and the worker publishes it without payment.
- **Impact:** Free publishing leak.
- **Fix:** Create as `"draft"`, flip to `"scheduled"` only after successful deduct (or move deduct before creation, like `api.schedule.approve.ts` does).

### H9. "Analyze" crashes (500) for campaigns created outside AdPilot
- **Files:** `app/routes/api.ai.analyze-campaign.ts:49, 83-86, 117`
- **What:** `const campaign` is declared inside the `else` branch (AdPilot-record path), but lines 83–86 and 117 use `campaign.name/objective/...` unconditionally. The "From Meta Ads Manager" path POSTs `{metaCampaignId, adAccountId}` → `ReferenceError`.
- **Impact:** 📊 Analyze broken for every campaign not created in AdPilot.
- **Fix:** Build the prompt from `campaignName` (already available) with defaults in the direct branch.

### H10. Coupon race in top-up callback: paid charge can yield zero credit
- **Files:** `app/routes/app.wallet.topup.tsx:54-73`
- **What:** `findUnique(alreadyUsed)` → `couponRedemption.create()` → `topup()`, no transaction. Two parallel callbacks both pass the check; the loser's `create` hits the `@@unique([couponId, shop])` constraint and throws BEFORE `topup()` — merchant paid Shopify, gets an error page and no credit.
- **Impact:** Paid-but-uncredited top-up; support nightmare.
- **Fix:** Wrap redemption + topup in `prisma.$transaction`; catch the unique-violation and continue with `couponBonus = 0`; plus the C1 idempotency check.

### H11. Lifetime double-activation race → double charge
- **Files:** `app/routes/api.schedule.lifetime.ts:42-66`
- **What:** `findFirst({ status: "active" })` → `deduct` → `create`, not atomic. Two parallel Activates both see no active package → both deduct ($40.50–$135 each).
- **Impact:** Double charge for the same pack.
- **Fix:** Transaction with re-check, or a partial unique constraint on `(shop)` where `status = 'active'`.

---

## 🟡 MEDIUM

### M1. Scheduled-post worker failure keeps the fee (inconsistent with publish-now)
- **Files:** `app/lib/scheduler.server.ts:73-81` vs `app.compose.tsx:158` (refunds)
- **Fix:** Refund on worker failure, or add Retry for failed posts (no re-charge).

### M2. Posts stuck in `"publishing"` forever on crash; `"failed"` is terminal
- **Files:** `app/lib/scheduler.server.ts:45-48` · `app/routes/api.schedule.post.ts:26-31`
- **What:** Process dies between claim and update → post stays `"publishing"` permanently (worker only claims `"scheduled"`; edit/delete API rejects `"publishing"`). Fee already paid; post can't publish or be deleted.
- **Fix:** On worker boot, reset `publishing` posts with `updatedAt` older than ~5 min back to `scheduled`; add retry for `failed`.

### M3. Timezone bug — "09:00" means 09:00 UTC for everyone
- **Files:** `app/routes/api.schedule.approve.ts:147` (`new Date(\`${p.date}T${p.time}:00Z\`)`) · `api.schedule.post.ts:57` · `app.compose.tsx:174`
- **What:** No timezone conversion anywhere. A US merchant scheduling "09:00" gets 09:00 UTC (4–8h early).
- **Impact:** Every non-UTC merchant's posts go out at the wrong local time.
- **Fix:** Capture the browser timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) or the Shopify shop timezone, convert to UTC before storing. Stopgap: label the field "Post time (UTC)".

### M4. Free AI endpoints have no rate limiting — cost-abuse vector
- **Files:** `app/routes/api.support.chat.ts` · `app/routes/api.schedule.suggest-topics.ts` · `api.ai.analyze-campaign.ts` (also completely free — decide: charge $0.20 or keep free)
- **What:** Unlimited free calls; each costs ~$0.001–$0.01 in provider fees. No per-shop throttle, no wallet charge.
- **Fix:** Per-shop daily caps (e.g. 30 support msgs/day, 20 topic suggestions/day) with 429 + friendly message; aggregate `logActivity`.

### M5. `source: "funnel"` fee waiver is client-controlled
- **Files:** `app/routes/api.ai.generate-creative.ts:33`
- **What:** Any admin session can POST `{"source":"funnel"}` and skip the $0.20 creative fee — no server-side proof a funnel fee was paid.
- **Fix:** Validate against a recent paid `FunnelGroup`/draft belonging to the shop, or issue a signed one-time waiver token at funnel-fee time.

### M6. No stale-token handling — expired Meta tokens kill paid posts cryptically
- **Files:** `app/lib/meta.server.ts:30-43` · `app/lib/meta-ads.server.ts:47-56` · `scheduler.server.ts:73-80`
- **What:** Code 190 (invalid token) surfaces as a raw Meta string; the post is terminally `failed`; nothing tells the merchant to reconnect in Accounts.
- **Fix:** Map code 190 → "Your Facebook connection expired — reconnect in Accounts"; don't terminal-fail the post; flag the account record.

### M7. Reviews API: no per-shop limit, no spam protection (+ stale comment)
- **Files:** `app/routes/api.reviews.ts`
- **What:** Unlimited reviews per shop; no unique constraint. (Doc comment says approval is needed; code publishes instantly — the comment is stale, instant-publish is intended.)
- **Fix:** One review per shop (editable afterwards) + fix the comment.

### M8. Schedule-package approve: charged with no posts if DB write fails; double-click double-charges
- **Files:** `app/routes/api.schedule.approve.ts:75-116`
- **What:** `deduct` runs before `schedulePackage.create` + post-creation transaction with no try/catch — DB failure after deduct = charged, nothing delivered, no refund. Double-clicking Approve double-charges and duplicates posts.
- **Fix:** try/catch + `refund()` on DB failure; idempotency key on the approve action.

### M9. Deleting a scheduled post gives no refund
- **Files:** `app/routes/api.schedule.post.ts` (delete branch)
- **What:** Fee taken at schedule time; delete just deletes. Merchant paid for a post that never runs.
- **Fix:** `refund()` the original fee when deleting a `scheduled`/`draft` post.

### M10. Pixel "connected" indicator is cosmetic — no live verification
- **Files:** `app/routes/app.ads.create.tsx:528-530`
- **What:** "✓ Meta Pixel {id} connected" is shown from the saved DB value only. Nothing verifies the pixel fires.
- **Impact:** Merchants run Sales campaigns believing conversions are tracked.
- **Fix:** "Send test event" button (Meta test events API) or a diagnostics card querying recent pixel event stats.

### M11. No Business Manager name display or BM switcher
- **Files:** `app/routes/app.accounts.tsx`
- **What:** Pixels/ad accounts show without their parent BM; multi-BM merchants can't distinguish them.
- **Fix:** Fetch `/me/businesses` and label each ad account + pixel with its BM; add a BM filter.

### M12. No storefront pixel — "website" audiences have no data source
- **Files:** (no `extensions/` directory exists)
- **What:** The Pixel ID is used for `OFFSITE_CONVERSIONS` in campaign creation, but nothing injects the pixel into the merchant's storefront. Website-audience types will stay empty forever.
- **Impact:** A listed feature (website audiences) is effectively broken.
- **Fix:** Ship a theme app extension with a Meta web pixel + one-click "Connect pixel to storefront" toggle.

### M13. AI auto-audience burns owner AI cost before the wallet check
- **Files:** `app/routes/app.ads.audiences.tsx:~190-238`
- **What:** AI targeting generation runs before the balance check/deduct. Insufficient-balance merchants cost you an AI call, then get redirected to top up.
- **Fix:** Move the wallet check before the AI call.

### M14. `read_products` scope: toml says `scopes = ""` but the product picker needs it
- **Files:** `shopify.app.toml` (`[access_scopes] scopes = ""`) · `app/routes/api.shop.catalog.ts` (Admin `products` query) · `app/shopify.server.ts` (reads `SCOPES` env)
- **What:** The Compose product picker queries Shopify products, which requires `read_products`. The toml requests no scopes; whether the Railway `SCOPES` env fills the gap is unverified from here.
- **Impact:** If missing, the picker fails with an access error.
- **Fix:** Verify `SCOPES` on Railway; declare `read_products` in the toml (source of truth at deploy) and reinstall on the dev store to re-consent. (`write_files` is NOT needed — uploads go to local `/data/media`.)

### M15. `AI_VAULT_KEY` falls back to `SHOPIFY_API_SECRET`
- **Files:** `app/lib/ai-providers.server.ts:108-112`
- **What:** Same secret derives the AI-key encryption key and signs Shopify sessions. A `SHOPIFY_API_SECRET` rotation orphans all encrypted provider keys. The dedicated `AI_VAULT_KEY` env var is still not set on Railway.
- **Fix:** Set `AI_VAULT_KEY` on Railway (already on the todo list); consider failing closed instead of falling back.

### M16. Misleading "cannot be refunded" copy
- **Files:** `app/routes/app.ads.create.tsx:948` · `app.ads.funnel.tsx:924-925`
- **What:** Copy says the fee "cannot be refunded", but both routes DO refund on Meta failure.
- **Fix:** "The fee is refunded automatically if Meta rejects the publish."

---

## 🔵 LOW

- **L1.** Scheduler `take: 50` with no per-shop fairness — one shop can starve others per pass (`scheduler.server.ts:37`).
- **L2.** `GET /api/admin/add-balance` mutates state — should be POST-only (`api.admin.add-balance.ts`).
- **L3.** No `nosniff` header on `/media/:filename` (`media.$filename.tsx`).
- **L4.** `refund()` has no `amount > 0` validation (unlike `deduct`/`topup`) (`wallet.server.ts:126`).
- **L5.** Dangling `active` audience record if `deduct` throws after create (`app.ads.audiences.tsx`).
- **L6.** Toggle/Delete desync when a campaign was deleted on Meta's side — DB keeps stale `active` (`app.ads.campaigns.tsx`).
- **L7.** Coupon `expiresAt` compared in server UTC; document the edge case.
- **L8.** `shop.redact` only deletes sessions — wallets/coupons/activity survive; make a deliberate retention decision.
- **L9.** Copy-paste comment drift in webhook files (mentions another app's "bar configuration").
- **L10.** `api.admin.add-balance.ts:16` parses `FREE_SHOP_DOMAINS` case-sensitively instead of using `normalizeShopDomain`.
- **L11.** Free-shop skips in `api.schedule.approve.ts:75` / `api.schedule.lifetime.ts:64` write no `$0` "waived" ledger entry (unlike `deduct()`'s own bypass) — ledger inconsistency only.

---

## ✅ VERIFIED CORRECT (do not re-audit)

- Scheduler claim is atomic (`updateMany` where `status: "scheduled"`); safe across concurrent ticks and instances. Manual trigger uses the same pass. No double-publish vector.
- Deduct-before-Meta + refund-on-failure is correctly implemented in every flow: compose publish-now, audiences (manual + auto), campaign create, funnel (full refund on all-stage failure + on exception), AI caption/image/creative/suggest. All insufficient-balance redirects happen BEFORE deduct.
- Fee amounts match `pricing.ts` at every charge site (objectives, funnel $10.50, audiences, AI fees, packages, lifetime formula). UI copy matches except H4.
- Coupon math: bonus = `pack.price × bonusPercent` (correct base); expired/inactive rejected in both validator and callback; one-use-per-store enforced by code + `@@unique([couponId, shop])`.
- Free-shop bypass: `isFreeShop` checked before every deduct (call-site pre-check + backstop inside `deduct()`); `shop` always from the Shopify-verified session; `refund()` is a correct no-op for free shops.
- Scheduler `fix-times` loop provably terminates (30-min steps, minute-precision keys); midnight rollover handled; approve auto-spread checks DB + batch.
- Meta OAuth: `state` HMAC-signed with `timingSafeEqual`, 60-min expiry, callback re-verifies; `redirect_uri` from env; `client_secret` server-side only.
- Webhooks use `authenticate.webhook` (HMAC) in all routes. No path traversal in media serving (UUID regex + basename + allowlist). Uploads: admin auth, 20MB cap, MIME allowlist, random filenames.
- No `shop`-as-client-param auth bypass; cross-shop queries scoped. No secrets in git history (scanned). AI keys never reach the browser. `expiringOfflineAccessTokens` + new embedded auth strategy enabled.

---

## 🗺️ ROADMAP STATUS (the 6 known pendings)

| # | Item | Status |
|---|------|--------|
| a | Draft campaign Edit / Retry-publish | ❌ Missing — only Delete exists (H6) |
| b | Pixel live diagnostics | ❌ Missing — cosmetic indicator only (M10) |
| c | Pixel ↔ storefront connection | ❌ Missing — no web pixel/extension (M12) |
| d | BM name display + switch | ❌ Missing (M11) |
| e | `read_products` / `write_files` scopes | ⚠️ `read_products` unverified, likely missing (M14); `write_files` NOT needed |
| f | Lifetime quota exemption | ❌ Missing — and worse: the whole lifetime feature is unwired (C2) |

---

## 🎯 SUGGESTED FIX ORDER

1. **C1** (top-up replay) + **C4** (atomic deduct) — money-integrity, small fixes
2. **C3** (Suggest 500) — one-line fix, broken for all paying users
3. **C2** (Lifetime unwired) — decide: build the worker or pull the UI (do NOT leave a paid-but-dead feature live)
4. **H1** (webhooks) — App Store review risk
5. **H2** (fail-closed admin) + **H3** (token encryption) — security
6. **H4–H11, M1–M16** — in priority order above
7. Lows — opportunistic
