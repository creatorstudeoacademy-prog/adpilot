import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken } from "../lib/token-vault.server";
import { getPixelInfo, getAdPixels } from "../lib/meta-ads.server";
import { deduct } from "../lib/wallet.server";
import { checkRateLimit } from "../lib/rate-limit.server";
import { logActivity } from "../lib/activity.server";

const META_VERSION = "v21.0";
const FIX_FEE = 1.5; // USD — one-click pixel fix

export interface DoctorIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  fixLabel?: string;
  fixAction?: string;
  steps?: string[];
}

interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  test: boolean;
  displayFinancialStatus: string;
  paymentGatewayNames: string[];
  customer?: { email?: string | null } | null;
}

async function fetchRecentOrders(admin: any): Promise<ShopifyOrder[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await admin.graphql(
    `#graphql
    query($since: String!) {
      orders(first: 100, query: $since, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            test
            displayFinancialStatus
            paymentGatewayNames
            totalPriceSet { shopMoney { amount currencyCode } }
            customer { email }
          }
        }
      }
    }`,
    { variables: { since: `created_at:>=${since}` } },
  );
  const data = await res.json();
  return (data?.data?.orders?.edges ?? []).map((e: any) => e.node as ShopifyOrder);
}

/** Diagnose pixel + data health. Returns issues with one-click fixes. */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const [adAccounts, metaToken, pixelSettings] = await Promise.all([
    prisma.adAccount.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
    prisma.metaUserToken.findUnique({ where: { shop } }),
    prisma.pixelSettings.findUnique({ where: { shop } }),
  ]);
  // Prefer the ad account that actually has a pixel saved.
  const adAccount =
    adAccounts.find((a) => a.pixelId?.trim()) ?? adAccounts[0] ?? null;

  const issues: DoctorIssue[] = [];
  const userToken = metaToken ? decryptToken(metaToken.accessToken) : null;

  // ---- 1. Real order data (Shopify) ----
  let orders: ShopifyOrder[] = [];
  let orderStats = { total: 0, revenue: 0, currency: "USD", testOrders: 0, zeroValue: 0, unpaid: 0 };
  try {
    orders = await fetchRecentOrders(admin);
    const real = orders.filter((o) => !o.test);
    orderStats = {
      total: real.length,
      revenue: Math.round(real.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount || "0"), 0) * 100) / 100,
      currency: real[0]?.totalPriceSet.shopMoney.currencyCode ?? "USD",
      testOrders: orders.filter((o) => o.test).length,
      zeroValue: real.filter((o) => parseFloat(o.totalPriceSet.shopMoney.amount || "0") <= 0).length,
      unpaid: real.filter((o) => o.displayFinancialStatus === "PENDING" || o.displayFinancialStatus === "UNPAID").length,
    };
  } catch (e) {
    const reinstallUrl = `https://admin.shopify.com/store/${shop}/oauth/authorize?client_id=f5feb18942e0d098f96e02c31159d136&scope=read_products,read_orders&redirect_uri=https://adpilot-production-c9f8.up.railway.app/auth/callback`;
    issues.push({
      id: "orders_unreadable",
      severity: "warning",
      title: "Could not read Shopify orders",
      detail: "AdPilot needs the read_orders permission to compare real sales with ad-reported purchases.",
      fixLabel: "Grant permission",
      fixAction: "reinstall|" + reinstallUrl,
    });
  }

  // Fake / test order detection
  if (orderStats.testOrders > 0) {
    issues.push({
      id: "test_orders",
      severity: orderStats.testOrders > 10 ? "critical" : "warning",
      title: `${orderStats.testOrders} test order${orderStats.testOrders === 1 ? "" : "s"} detected`,
      detail:
        "Test orders pollute your pixel and ad data — Meta optimizes toward fake buyers. They are excluded from AdPilot's strategy, but you should clean them up.",
      steps: [
        "In Shopify admin go to Orders and filter by the 'test' tag.",
        "Delete test orders, or keep them but never include them in reports.",
        "In Meta Events Manager → Test Events, make sure no test code is left in your live pixel.",
        "Going forward, fire test events only with a test_event_code so they never mix with live data.",
      ],
    });
  }
  if (orderStats.zeroValue > 0) {
    issues.push({
      id: "zero_orders",
      severity: "warning",
      title: `${orderStats.zeroValue} $0 order${orderStats.zeroValue === 1 ? "" : "s"} in the last 30 days`,
      detail: "Zero-value orders (free samples, staff orders, fraud checks) inflate purchase counts without revenue.",
      steps: [
        "Tag staff/free orders in Shopify so you can filter them out.",
        "If these are real fraud attempts, enable Shopify's fraud analysis warnings.",
      ],
    });
  }

  // ---- 2. Pixel checks ----
  const pixelId = adAccount?.pixelId?.trim() || pixelSettings?.pixelId?.trim() || null;
  let pixelInfo: { lastFired?: string | null; name?: string } | null = null;
  let pixelsAvailable: Array<{ id: string; name: string }> = [];

  if (!pixelId) {
    issues.push({
      id: "no_pixel",
      severity: "critical",
      title: "No pixel connected",
      detail: "Without a pixel, Meta cannot track purchases and your ads optimize blind. Connect one now — no page reload needed.",
      fixLabel: "Set up pixel here",
      fixAction: "setup_pixel",
    });
  } else if (userToken) {
    try {
      const info = await getPixelInfo(pixelId, userToken);
      pixelInfo = { lastFired: info?.last_fired_time ?? null, name: info?.name };
      const lastFired = info?.last_fired_time ? new Date(info.last_fired_time).getTime() : 0;
      const hours = lastFired ? (Date.now() - lastFired) / 3600000 : Infinity;
      if (!lastFired || hours > 24) {
        issues.push({
          id: "pixel_silent",
          severity: "critical",
          title: "Pixel has not fired recently",
          detail: lastFired
            ? `Last event was ${Math.round(hours)} hours ago. Your store may not be sending data to Meta.`
            : "This pixel has never fired. No purchase data is reaching Meta.",
          fixLabel: `Send test event ($${FIX_FEE.toFixed(2)})`,
          fixAction: "fix_silent_pixel",
          steps: [
            "Make sure the AdPilot web pixel is enabled: Shopify admin → Online Store → Themes → Customize → App embeds → AdPilot.",
            "Check that the pixel ID saved here matches the one in Meta Events Manager.",
            "After fixing, send a test event to confirm data flows.",
          ],
        });
      }
    } catch {
      issues.push({
        id: "pixel_unreachable",
        severity: "warning",
        title: "Could not verify pixel status",
        detail: "Meta did not return pixel info. Your token may need App Review approval or a reconnect.",
      });
    }
    // Fetch available pixels for inline setup
    if (adAccount?.adAccountId) {
      try {
        pixelsAvailable = await getAdPixels(adAccount.adAccountId, userToken);
      } catch {
        /* ignore */
      }
    }
  }

  // ---- 2b. Website connection check (our own collector = ground truth) ----
  if (pixelId) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const browserEvents = await prisma.pixelEvent.count({
      where: { shop, pixelId, source: "browser", createdAt: { gte: dayAgo } },
    });
    const anyEvents = await prisma.pixelEvent.count({
      where: { shop, pixelId, createdAt: { gte: dayAgo } },
    });
    if (browserEvents === 0) {
      issues.push({
        id: "website_not_connected",
        severity: "critical",
        title: "Pixel is NOT receiving website data",
        detail:
          anyEvents > 0
            ? "Your pixel gets test/manual events, but ZERO events from your website in the last 24h. The web pixel is not installed or not enabled on your storefront."
            : "No events from your website in the last 24h. The web pixel is not sending data.",
        steps: [
          "Deploy the web pixel: run 'shopify app deploy' from your terminal (one time).",
          "Then in Shopify admin go to Online Store → Themes → Customize → App embeds → turn ON AdPilot.",
          "Fill the app_url and shop fields in the pixel settings.",
          "Visit your storefront once — the Pixel Live Hub should start showing live events within a minute.",
        ],
      });
    }
  }

  // ---- 3. Data-quality filter checks ----
  const filters = {
    dedupe: pixelSettings?.dedupeEnabled ?? true,
    bot: pixelSettings?.botFilterEnabled ?? true,
    pii: pixelSettings?.piiScrubEnabled ?? true,
    value: pixelSettings?.requireValueCurrency ?? true,
    staff: pixelSettings?.staffFilterEnabled ?? false,
  };
  const disabled = Object.entries(filters).filter(([k, v]) => !v && k !== "staff");
  if (disabled.length > 0) {
    issues.push({
      id: "filters_off",
      severity: "warning",
      title: `${disabled.length} data-quality filter${disabled.length === 1 ? "" : "s"} off`,
      detail: `Off: ${disabled.map(([k]) => k).join(", ")}. Dirty data reaches your pixel and weakens optimization.`,
      fixLabel: `Enable all filters ($${FIX_FEE.toFixed(2)})`,
      fixAction: "fix_filters",
    });
  }

  // ---- 4. Meta token check ----
  if (!metaToken) {
    issues.push({
      id: "no_token",
      severity: "critical",
      title: "Meta not connected",
      detail: "Connect your Meta account from the Accounts page to unlock pixel setup and ad data.",
    });
  }

  return json({
    ok: true,
    orderStats,
    pixel: {
      id: pixelId,
      name: pixelInfo?.name,
      lastFired: pixelInfo?.lastFired,
      websiteConnected: pixelId
        ? (await prisma.pixelEvent.count({
            where: { shop, pixelId, source: "browser", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          })) > 0
        : false,
    },
    pixelsAvailable,
    issues,
    fixFee: FIX_FEE,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "fix") {
    const fixAction = String(form.get("fixAction") ?? "");
    const rl = await checkRateLimit(shop, "data_doctor_fix", 20);
    if (!rl.allowed) return json({ ok: false, message: "Too many fix attempts. Try again tomorrow." }, { status: 429 });

    if (fixAction.startsWith("reinstall|")) {
      const url = fixAction.slice("reinstall|".length);
      return json({ ok: true, redirect: url, message: "Opening the permission grant page…" });
    }

    if (fixAction === "fix_filters") {
      await deduct(shop, FIX_FEE, `Pixel Doctor: enabled all data-quality filters`);
      await prisma.pixelSettings.upsert({
        where: { shop },
        create: { shop, dedupeEnabled: true, botFilterEnabled: true, piiScrubEnabled: true, requireValueCurrency: true },
        update: { dedupeEnabled: true, botFilterEnabled: true, piiScrubEnabled: true, requireValueCurrency: true },
      });
      await logActivity({ shop, action: "pixel_doctor_fix", detail: "Enabled all data-quality filters", feeCharged: FIX_FEE });
      return json({ ok: true, message: "All data-quality filters are now ON. Your pixel data will be cleaner from this point." });
    }

    if (fixAction === "fix_silent_pixel") {
      const [adAccount, metaToken] = await Promise.all([
        prisma.adAccount.findFirst({ where: { shop } }),
        prisma.metaUserToken.findUnique({ where: { shop } }),
      ]);
      const pixelId = adAccount?.pixelId?.trim();
      if (!pixelId || !metaToken) return json({ ok: false, message: "No pixel or Meta connection found." });
      await deduct(shop, FIX_FEE, `Pixel Doctor: sent test event to pixel ${pixelId}`);
      const token = decryptToken(metaToken.accessToken);
      // Send a PageView test event through Meta's test endpoint
      const testCode = `ADPILOT-${Date.now()}`;
      const res = await fetch(`https://graph.facebook.com/${META_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [
            {
              event_name: "PageView",
              event_time: Math.floor(Date.now() / 1000),
              event_id: `doctor-${Date.now()}`,
              action_source: "website",
              event_source_url: `https://${shop}`,
              user_data: { client_user_agent: "AdPilot-Pixel-Doctor/1.0" },
            },
          ],
          test_event_code: testCode,
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (out.error) return json({ ok: false, message: `Meta refused the test event: ${out.error.message}` });
      await prisma.pixelEvent.create({
        data: { shop, pixelId, eventName: "PageView", source: "test", url: `https://${shop}`, eventId: `doctor-${Date.now()}` },
      });
      await logActivity({ shop, action: "pixel_doctor_fix", detail: `Test event sent to pixel ${pixelId}`, feeCharged: FIX_FEE });
      return json({
        ok: true,
        message: `Test event sent! Open Meta Events Manager → Test Events and enter code ${testCode} to see it live. If nothing appears, your web pixel is not installed — enable it in Theme editor → App embeds.`,
      });
    }

    if (fixAction === "setup_pixel") {
      const pixelId = String(form.get("pixelId") ?? "").trim();
      if (!pixelId) return json({ ok: false, message: "Choose a pixel first." });
      const adAccount = await prisma.adAccount.findFirst({ where: { shop } });
      if (!adAccount) return json({ ok: false, message: "Connect an ad account first (Accounts page)." });
      await prisma.adAccount.update({ where: { id: adAccount.id }, data: { pixelId } });
      await prisma.pixelSettings.upsert({
        where: { shop },
        create: { shop, pixelId },
        update: { pixelId },
      });
      await logActivity({ shop, action: "pixel_doctor_fix", detail: `Connected pixel ${pixelId} from Pixel Doctor`, feeCharged: 0 });
      return json({ ok: true, message: `Pixel ${pixelId} is now connected. Live data will appear in the Pixel Live Hub.` });
    }

    return json({ ok: false, message: "Unknown fix." });
  }

  return json({ ok: false, message: "Unknown intent." }, { status: 400 });
}
