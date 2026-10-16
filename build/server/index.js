var _a;
import { jsx, jsxs } from "react/jsx-runtime";
import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable, json, redirect } from "@remix-run/node";
import { RemixServer, Meta, Links, Outlet, ScrollRestoration, Scripts, useLoaderData, useActionData, useNavigation, useSubmit, Form, Link, useRouteError } from "@remix-run/react";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import "@shopify/shopify-app-remix/adapters/node";
import { shopifyApp, BillingInterval, AppDistribution, ApiVersion, boundary } from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { PrismaClient } from "@prisma/client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Page, Layout, BlockStack, Card, Text, DataTable, EmptyState, InlineStack, Button, Badge, Banner, Grid, List, FormLayout, Checkbox, TextField, Divider, AppProvider } from "@shopify/polaris";
import { AppProvider as AppProvider$1 } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
const ABORT_DELAY = 5e3;
function handleRequest(request, responseStatusCode, responseHeaders, remixContext, loadContext) {
  return isbot(request.headers.get("user-agent") || "") ? handleBotRequest(
    request,
    responseStatusCode,
    responseHeaders,
    remixContext
  ) : handleBrowserRequest(
    request,
    responseStatusCode,
    responseHeaders,
    remixContext
  );
}
function handleBotRequest(request, responseStatusCode, responseHeaders, remixContext) {
  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      /* @__PURE__ */ jsx(
        RemixServer,
        {
          context: remixContext,
          url: request.url,
          abortDelay: ABORT_DELAY
        }
      ),
      {
        onAllReady() {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        }
      }
    );
    setTimeout(abort, ABORT_DELAY);
  });
}
function handleBrowserRequest(request, responseStatusCode, responseHeaders, remixContext) {
  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      /* @__PURE__ */ jsx(
        RemixServer,
        {
          context: remixContext,
          url: request.url,
          abortDelay: ABORT_DELAY
        }
      ),
      {
        onShellReady() {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        }
      }
    );
    setTimeout(abort, ABORT_DELAY);
  });
}
const entryServer = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: handleRequest
}, Symbol.toStringTag, { value: "Module" }));
function App$1() {
  return /* @__PURE__ */ jsxs("html", { lang: "en", children: [
    /* @__PURE__ */ jsxs("head", { children: [
      /* @__PURE__ */ jsx("meta", { charSet: "utf-8" }),
      /* @__PURE__ */ jsx("meta", { name: "viewport", content: "width=device-width,initial-scale=1" }),
      /* @__PURE__ */ jsx(Meta, {}),
      /* @__PURE__ */ jsx(Links, {})
    ] }),
    /* @__PURE__ */ jsxs("body", { children: [
      /* @__PURE__ */ jsx(Outlet, {}),
      /* @__PURE__ */ jsx(ScrollRestoration, {}),
      /* @__PURE__ */ jsx(Scripts, {})
    ] })
  ] });
}
const route0 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: App$1
}, Symbol.toStringTag, { value: "Module" }));
let prisma;
if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  if (!global.__db__) {
    global.__db__ = new PrismaClient();
  }
  prisma = global.__db__;
  prisma.$connect();
}
const db = prisma;
const PRO_PLAN = "PixelPro";
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes: (_a = process.env.SCOPES) == null ? void 0 : _a.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(db),
  distribution: AppDistribution.AppStore,
  billing: {
    [PRO_PLAN]: {
      lineItems: [
        {
          amount: 12.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days
        }
      ],
      trialDays: 7
    }
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true
  },
  ...process.env.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] } : {}
});
ApiVersion.January26;
shopify.addDocumentResponseHeaders;
const authenticate = shopify.authenticate;
shopify.unauthenticated;
const login = shopify.login;
shopify.registerWebhooks;
shopify.sessionStorage;
const action$7 = async ({ request }) => {
  var _a2;
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop} (customer ${((_a2 = payload.customer) == null ? void 0 : _a2.id) ?? "unknown"}) — no customer data stored, nothing to return.`
  );
  return new Response();
};
const route1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action: action$7
}, Symbol.toStringTag, { value: "Module" }));
const action$6 = async ({ request }) => {
  const { payload, session, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${payload.shop_domain}`);
  const current = payload.current;
  if (session) {
    await db.session.update({
      where: { id: session.id },
      data: { scope: current.toString() }
    });
  }
  return new Response();
};
const route2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action: action$6
}, Symbol.toStringTag, { value: "Module" }));
const action$5 = async ({ request }) => {
  var _a2;
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop} (customer ${((_a2 = payload.customer) == null ? void 0 : _a2.id) ?? "unknown"}) — no customer data stored, nothing to erase.`
  );
  return new Response();
};
const route3 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action: action$5
}, Symbol.toStringTag, { value: "Module" }));
const action$4 = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  return new Response();
};
const route4 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action: action$4
}, Symbol.toStringTag, { value: "Module" }));
const action$3 = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop} (shop_id ${payload.shop_id ?? "unknown"}) — deleting sessions.`
  );
  await db.session.deleteMany({ where: { shop } });
  return new Response();
};
const route5 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action: action$3
}, Symbol.toStringTag, { value: "Module" }));
const eventsByShop = /* @__PURE__ */ new Map();
const MAX_EVENTS = 100;
function getRecentEvents(shop) {
  return eventsByShop.get(shop) ?? [];
}
const action$2 = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ ok: false }, { status: 405 });
  }
  try {
    const body = await request.json();
    const shop = String(body.shop ?? "").trim();
    const event = String(body.event ?? "").trim();
    const pixel = String(body.pixel ?? "").trim();
    if (!shop || !event || !pixel) {
      return json({ ok: false }, { status: 400 });
    }
    const entry2 = {
      shop,
      event,
      pixel,
      page: String(body.page ?? ""),
      timestamp: Date.now()
    };
    const list = eventsByShop.get(shop) ?? [];
    list.unshift(entry2);
    eventsByShop.set(shop, list.slice(0, MAX_EVENTS));
    return json({ ok: true });
  } catch {
    return json({ ok: false }, { status: 400 });
  }
};
const route6 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action: action$2,
  getRecentEvents
}, Symbol.toStringTag, { value: "Module" }));
const SETTINGS_NAMESPACE = "pixelpro";
const SETTINGS_KEY = "config";
const DEFAULT_SETTINGS = {
  enabled: true,
  metaPixelId: "",
  tiktokPixelId: "",
  googleTagId: "",
  snapchatPixelId: ""
};
const PRO_ONLY_FIELDS = [
  "tiktokPixelId",
  "googleTagId",
  "snapchatPixelId"
];
async function getSettings(admin) {
  var _a2, _b, _c;
  const response = await admin.graphql(
    `#graphql
      query GetPixelConfig($namespace: String!, $key: String!) {
        shop {
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }`,
    {
      variables: {
        namespace: SETTINGS_NAMESPACE,
        key: SETTINGS_KEY
      }
    }
  );
  const data = await response.json();
  const raw = (_c = (_b = (_a2 = data == null ? void 0 : data.data) == null ? void 0 : _a2.shop) == null ? void 0 : _b.metafield) == null ? void 0 : _c.value;
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
async function saveSettings(admin, settings) {
  var _a2, _b, _c, _d;
  const shopResponse = await admin.graphql(
    `#graphql
      query GetShopId {
        shop {
          id
        }
      }`
  );
  const shopData = await shopResponse.json();
  const shopId = (_b = (_a2 = shopData == null ? void 0 : shopData.data) == null ? void 0 : _a2.shop) == null ? void 0 : _b.id;
  if (!shopId) {
    throw new Error("Could not resolve shop ID; settings were not saved.");
  }
  const response = await admin.graphql(
    `#graphql
      mutation SetPixelConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: SETTINGS_NAMESPACE,
            key: SETTINGS_KEY,
            type: "json",
            value: JSON.stringify(settings)
          }
        ]
      }
    }
  );
  const data = await response.json();
  const userErrors = ((_d = (_c = data == null ? void 0 : data.data) == null ? void 0 : _c.metafieldsSet) == null ? void 0 : _d.userErrors) ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      userErrors.map((e) => e.message).join("; ")
    );
  }
}
const loader$5 = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getSettings(admin);
  const events = getRecentEvents(session.shop);
  return json({
    settings,
    events,
    shopDomain: session.shop,
    appUrl: process.env.SHOPIFY_APP_URL ?? ""
  });
};
const TEST_LINKS = [
  {
    pixel: "Meta",
    url: "https://www.facebook.com/events_manager2/list/dataset",
    label: "Open Meta Events Manager → Test Events"
  },
  {
    pixel: "TikTok",
    url: "https://events.tiktok.com/events_manager",
    label: "Open TikTok Events Manager"
  },
  {
    pixel: "Google",
    url: "https://tagassistant.google.com/",
    label: "Open Google Tag Assistant"
  },
  {
    pixel: "Snapchat",
    url: "https://ads.snapchat.com/",
    label: "Open Snapchat Ads Manager → Events Manager"
  }
];
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1e3);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
function DiagnosticsPage() {
  const { settings, events, appUrl } = useLoaderData();
  const [liveEvents, setLiveEvents] = useState(events);
  useEffect(() => {
    setLiveEvents(events);
  }, [events]);
  const configured = [
    { label: "Meta Pixel", id: settings.metaPixelId, test: TEST_LINKS[0] },
    { label: "TikTok Pixel", id: settings.tiktokPixelId, test: TEST_LINKS[1] },
    { label: "Google Tag", id: settings.googleTagId, test: TEST_LINKS[2] },
    { label: "Snapchat Pixel", id: settings.snapchatPixelId, test: TEST_LINKS[3] }
  ];
  const rows = liveEvents.map((e) => [
    timeAgo(e.timestamp),
    e.pixel,
    e.event,
    e.page || "—"
  ]);
  return /* @__PURE__ */ jsx(
    Page,
    {
      title: "Pixel Diagnostics",
      subtitle: "Live event feed from your storefront",
      backAction: { content: "Settings", url: "/app" },
      children: /* @__PURE__ */ jsxs(Layout, { children: [
        /* @__PURE__ */ jsx(Layout.Section, { children: /* @__PURE__ */ jsx(BlockStack, { gap: "500", children: /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
          /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Live event feed" }),
          /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: "Events fired by PixelPro on your storefront appear here in real time. Visit your store, browse a product, add to cart — then come back and refresh." }),
          rows.length > 0 ? /* @__PURE__ */ jsx(
            DataTable,
            {
              columnContentTypes: ["text", "text", "text", "text"],
              headings: ["When", "Pixel", "Event", "Page"],
              rows
            }
          ) : /* @__PURE__ */ jsx(
            EmptyState,
            {
              heading: "No events yet",
              image: "https://cdn.shopify.com/s/files/1/0262/4076/files/empty-state.svg",
              children: /* @__PURE__ */ jsx("p", { children: "No pixel events received yet. Make sure tracking is enabled, at least one pixel ID is saved, and the app embed is turned on — then visit your storefront." })
            }
          ),
          /* @__PURE__ */ jsx(InlineStack, { children: /* @__PURE__ */ jsx(
            Button,
            {
              onClick: () => window.location.reload(),
              children: "Refresh feed"
            }
          ) })
        ] }) }) }) }),
        /* @__PURE__ */ jsx(Layout.Section, { variant: "oneThird", children: /* @__PURE__ */ jsxs(BlockStack, { gap: "500", children: [
          /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
            /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Pixel status" }),
            configured.map((p) => /* @__PURE__ */ jsxs(BlockStack, { gap: "100", children: [
              /* @__PURE__ */ jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [
                /* @__PURE__ */ jsx(Text, { as: "span", variant: "bodyMd", children: p.label }),
                p.id ? /* @__PURE__ */ jsx(Badge, { tone: "success", children: "Configured" }) : /* @__PURE__ */ jsx(Badge, { children: "Not set" })
              ] }),
              p.id ? /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: p.id }) : null
            ] }, p.label))
          ] }) }),
          /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "300", children: [
            /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Test your pixels" }),
            /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: "Use each platform's official test tool to confirm events arrive:" }),
            TEST_LINKS.map((t) => /* @__PURE__ */ jsx(
              Button,
              {
                url: t.url,
                target: "_blank",
                fullWidth: true,
                textAlign: "left",
                children: t.label
              },
              t.pixel
            ))
          ] }) }),
          appUrl ? /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "300", children: [
            /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Server-side tracking" }),
            /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: "Browser pixels can be blocked by ad blockers and iOS privacy features. Server-side tracking (Meta Conversions API, TikTok Events API) sends events directly from our servers for maximum accuracy." }),
            /* @__PURE__ */ jsx(Badge, { tone: "info", children: "Coming soon" })
          ] }) }) : null
        ] }) })
      ] })
    }
  );
}
const route7 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: DiagnosticsPage,
  loader: loader$5
}, Symbol.toStringTag, { value: "Module" }));
const IS_TEST_BILLING$1 = process.env.NODE_ENV !== "production";
const PRO_PRICE = "$12.99";
const PRO_NAME = "PixelPro";
const loader$4 = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  const check = await billing.check({
    plans: [PRO_PLAN],
    isTest: IS_TEST_BILLING$1
  });
  const activeSubscription = (check.appSubscriptions ?? []).find(
    (sub) => sub.status === "ACTIVE"
  );
  return json({
    isPro: check.hasActivePayment,
    subscriptionId: (activeSubscription == null ? void 0 : activeSubscription.id) ?? null
  });
};
const action$1 = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent === "upgrade") {
    await billing.request({
      plan: PRO_PLAN,
      isTest: IS_TEST_BILLING$1,
      trialDays: 7,
      returnUrl: "/app/billing"
    });
  }
  if (intent === "downgrade") {
    const subscriptionId = String(formData.get("subscriptionId") ?? "");
    if (subscriptionId) {
      await billing.cancel({
        subscriptionId,
        isTest: IS_TEST_BILLING$1,
        prorate: true
      });
    }
    return json({ ok: true });
  }
  return json({ ok: false });
};
function BillingPage() {
  const { isPro, subscriptionId } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state === "submitting";
  const post = (intent) => {
    const data = new FormData();
    data.set("intent", intent);
    if (subscriptionId) data.set("subscriptionId", subscriptionId);
    submit(data, { method: "post" });
  };
  return /* @__PURE__ */ jsx(Page, { title: "Billing", subtitle: "Choose the plan that fits your store", children: /* @__PURE__ */ jsx(Layout, { children: /* @__PURE__ */ jsx(Layout.Section, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "500", children: [
    actionData && "ok" in actionData && actionData.ok && /* @__PURE__ */ jsx(Banner, { tone: "success", onDismiss: () => {
    }, children: "Your plan was updated." }),
    /* @__PURE__ */ jsxs(Grid, { children: [
      /* @__PURE__ */ jsx(Grid.Cell, { columnSpan: { xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }, children: /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
        /* @__PURE__ */ jsxs(BlockStack, { gap: "200", children: [
          /* @__PURE__ */ jsxs(Text, { as: "h2", variant: "headingMd", children: [
            "Free",
            " ",
            !isPro && /* @__PURE__ */ jsx(Badge, { tone: "success", children: "Current plan" })
          ] }),
          /* @__PURE__ */ jsx(Text, { as: "p", variant: "heading2xl", children: "$0" }),
          /* @__PURE__ */ jsxs(List, { type: "bullet", children: [
            /* @__PURE__ */ jsx(List.Item, { children: "Meta (Facebook) Pixel tracking" }),
            /* @__PURE__ */ jsx(List.Item, { children: "PageView, ViewContent, AddToCart, InitiateCheckout & Purchase events" }),
            /* @__PURE__ */ jsx(List.Item, { children: "One-click app embed install" })
          ] })
        ] }),
        !isPro ? /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: "You are on the Free plan." }) : /* @__PURE__ */ jsx(
          Button,
          {
            disabled: busy,
            onClick: () => post("downgrade"),
            children: "Downgrade to Free"
          }
        )
      ] }) }) }),
      /* @__PURE__ */ jsx(Grid.Cell, { columnSpan: { xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }, children: /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
        /* @__PURE__ */ jsxs(BlockStack, { gap: "200", children: [
          /* @__PURE__ */ jsxs(Text, { as: "h2", variant: "headingMd", children: [
            PRO_NAME,
            " ",
            isPro && /* @__PURE__ */ jsx(Badge, { tone: "success", children: "Current plan" })
          ] }),
          /* @__PURE__ */ jsxs(Text, { as: "p", variant: "heading2xl", children: [
            PRO_PRICE,
            /* @__PURE__ */ jsxs(Text, { as: "span", variant: "bodyMd", tone: "subdued", children: [
              " ",
              "/ month"
            ] })
          ] }),
          /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: "7-day free trial included" }),
          /* @__PURE__ */ jsxs(List, { type: "bullet", children: [
            /* @__PURE__ */ jsx(List.Item, { children: "Everything in Free" }),
            /* @__PURE__ */ jsx(List.Item, { children: "TikTok Pixel tracking" }),
            /* @__PURE__ */ jsx(List.Item, { children: "Google Tag (GA4 & Google Ads) tracking" }),
            /* @__PURE__ */ jsx(List.Item, { children: "Snapchat Pixel tracking" }),
            /* @__PURE__ */ jsx(List.Item, { children: "Priority support" })
          ] })
        ] }),
        isPro ? /* @__PURE__ */ jsxs(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: [
          "You are on the ",
          PRO_NAME,
          " plan."
        ] }) : /* @__PURE__ */ jsxs(
          Button,
          {
            variant: "primary",
            disabled: busy,
            loading: busy,
            onClick: () => post("upgrade"),
            children: [
              "Upgrade to ",
              PRO_NAME
            ]
          }
        )
      ] }) }) })
    ] }),
    /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: "Billing is handled securely by Shopify. Charges appear on your regular Shopify invoice and can be cancelled anytime." })
  ] }) }) }) });
}
const route8 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action: action$1,
  default: BillingPage,
  loader: loader$4
}, Symbol.toStringTag, { value: "Module" }));
const IS_TEST_BILLING = process.env.NODE_ENV !== "production";
function validatePixelId(key, value) {
  const v = value.trim();
  if (!v) return null;
  if (/\s/.test(v)) return "Pixel IDs cannot contain spaces.";
  if (v.length > 64) return "Pixel ID looks too long — check for a copy/paste error.";
  switch (key) {
    case "metaPixelId":
      return /^\d{6,20}$/.test(v) ? null : "Meta Pixel ID should be digits only, e.g. 1683359659412165.";
    case "tiktokPixelId":
      return /^[A-Za-z0-9]{10,32}$/.test(v) ? null : "TikTok Pixel ID should be letters and numbers, e.g. D2ABCD1234EFGH5678.";
    case "googleTagId":
      return /^(G|AW)-[A-Za-z0-9-]{5,20}$/.test(v) ? null : "Google Tag ID should look like G-XXXXXXXXXX or AW-XXXXXXXXXX.";
    case "snapchatPixelId":
      return /^[A-Za-z0-9-]{8,64}$/.test(v) ? null : "Snapchat Pixel ID looks invalid — copy it exactly from Snapchat Ads Manager.";
    default:
      return null;
  }
}
const loader$3 = async ({ request }) => {
  const { admin, billing, session } = await authenticate.admin(request);
  const [settings, billingCheck, embedStatus] = await Promise.all([
    getSettings(admin),
    billing.check({ plans: [PRO_PLAN], isTest: IS_TEST_BILLING }),
    checkEmbedEnabled(admin)
  ]);
  return json({
    settings,
    isPro: billingCheck.hasActivePayment,
    embedEnabled: embedStatus.enabled,
    shopDomain: session.shop
  });
};
async function checkEmbedEnabled(admin) {
  var _a2, _b, _c, _d, _e, _f, _g, _h;
  try {
    const response = await admin.graphql(
      `#graphql
        query GetMainTheme {
          themes(first: 10) {
            nodes {
              id
              role
            }
          }
        }`
    );
    const data = await response.json();
    const themes = ((_b = (_a2 = data == null ? void 0 : data.data) == null ? void 0 : _a2.themes) == null ? void 0 : _b.nodes) ?? [];
    const mainTheme = themes.find((t) => t.role === "MAIN") ?? themes[0];
    if (!mainTheme) return { enabled: false };
    const themeId = String(mainTheme.id).split("/").pop();
    const assetResponse = await admin.graphql(
      `#graphql
        query GetSettingsData($themeId: ID!) {
          theme(id: $themeId) {
            files(filenames: ["config/settings_data.json"], first: 1) {
              nodes {
                ... on OnlineStoreThemeFile {
                  content
                }
              }
            }
          }
        }`,
      { variables: { themeId: mainTheme.id } }
    );
    void themeId;
    const assetData = await assetResponse.json();
    const content = ((_g = (_f = (_e = (_d = (_c = assetData == null ? void 0 : assetData.data) == null ? void 0 : _c.theme) == null ? void 0 : _d.files) == null ? void 0 : _e.nodes) == null ? void 0 : _f[0]) == null ? void 0 : _g.content) ?? "";
    if (!content) return { enabled: false };
    const settingsData = JSON.parse(content);
    const blocks = ((_h = settingsData == null ? void 0 : settingsData.current) == null ? void 0 : _h.blocks) ?? {};
    for (const [key, block] of Object.entries(blocks)) {
      if (key.includes("pixel-pro") || (block == null ? void 0 : block.type) === "pixel-pro") {
        return { enabled: (block == null ? void 0 : block.disabled) !== true };
      }
    }
    return { enabled: false };
  } catch {
    return { enabled: false };
  }
}
const action = async ({ request }) => {
  const { admin, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const billingCheck = await billing.check({
    plans: [PRO_PLAN],
    isTest: IS_TEST_BILLING
  });
  const isPro = billingCheck.hasActivePayment;
  const errors = {};
  const values = {
    enabled: "",
    metaPixelId: String(formData.get("metaPixelId") ?? "").trim(),
    tiktokPixelId: String(formData.get("tiktokPixelId") ?? "").trim(),
    googleTagId: String(formData.get("googleTagId") ?? "").trim(),
    snapchatPixelId: String(formData.get("snapchatPixelId") ?? "").trim()
  };
  for (const key of ["metaPixelId", "tiktokPixelId", "googleTagId", "snapchatPixelId"]) {
    const err = validatePixelId(key, values[key]);
    if (err) errors[key] = err;
  }
  if (!values.metaPixelId && !values.tiktokPixelId && !values.googleTagId && !values.snapchatPixelId) {
    errors.form = "Add at least one pixel ID so PixelPro has something to install.";
  }
  if (Object.keys(errors).length > 0) {
    const data = { ok: false, errors };
    return json(data, { status: 400 });
  }
  const settings = {
    enabled: formData.get("enabled") === "on",
    metaPixelId: values.metaPixelId,
    // Pro-only pixels: free shops always get the defaults (server-enforced).
    tiktokPixelId: isPro ? values.tiktokPixelId : DEFAULT_SETTINGS.tiktokPixelId,
    googleTagId: isPro ? values.googleTagId : DEFAULT_SETTINGS.googleTagId,
    snapchatPixelId: isPro ? values.snapchatPixelId : DEFAULT_SETTINGS.snapchatPixelId
  };
  try {
    await saveSettings(admin, settings);
  } catch (e) {
    const data = {
      ok: false,
      errors: {
        form: e instanceof Error ? e.message : "Could not save settings."
      }
    };
    return json(data, { status: 500 });
  }
  const success = { ok: true, errors: {} };
  return json(success);
};
function PixelStatus({ settings }) {
  const pixels = [
    { label: "Meta", id: settings.metaPixelId },
    { label: "TikTok", id: settings.tiktokPixelId },
    { label: "Google", id: settings.googleTagId },
    { label: "Snapchat", id: settings.snapchatPixelId }
  ];
  const active = pixels.filter((p) => p.id.trim().length > 0);
  return /* @__PURE__ */ jsxs(BlockStack, { gap: "200", children: [
    pixels.map((p) => /* @__PURE__ */ jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [
      /* @__PURE__ */ jsxs(Text, { as: "span", variant: "bodyMd", children: [
        p.label,
        " Pixel"
      ] }),
      p.id.trim() ? /* @__PURE__ */ jsx(Badge, { tone: "success", children: "Installed" }) : /* @__PURE__ */ jsx(Badge, { children: "Not set" })
    ] }, p.label)),
    /* @__PURE__ */ jsx(Divider, {}),
    /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodySm", tone: "subdued", children: settings.enabled ? active.length > 0 ? `${active.length} pixel${active.length > 1 ? "s" : ""} will fire PageView, ViewContent, AddToCart, InitiateCheckout and Purchase events on your storefront.` : "Tracking is enabled but no pixel IDs are set yet." : "Tracking is paused — no pixels will fire until you re-enable it." })
  ] });
}
function SettingsPage() {
  const {
    settings: initial,
    isPro,
    embedEnabled,
    shopDomain
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSaving = navigation.state === "submitting";
  const [form, setForm] = useState(initial);
  const set = useCallback(
    (key, value) => setForm((prev) => ({ ...prev, [key]: value })),
    []
  );
  const proLocked = useMemo(
    () => (field) => !isPro && PRO_ONLY_FIELDS.includes(field),
    [isPro]
  );
  const handleSubmit = useCallback(
    (event) => {
      event.preventDefault();
      const data = new FormData();
      data.set("enabled", form.enabled ? "on" : "");
      data.set("metaPixelId", form.metaPixelId);
      data.set("tiktokPixelId", form.tiktokPixelId);
      data.set("googleTagId", form.googleTagId);
      data.set("snapchatPixelId", form.snapchatPixelId);
      submit(data, { method: "post" });
    },
    [form, submit]
  );
  const errors = (actionData == null ? void 0 : actionData.errors) ?? {};
  return /* @__PURE__ */ jsx(
    Page,
    {
      title: "PixelPro — Multi Pixel Manager",
      subtitle: isPro ? "PixelPro plan active" : "Free plan",
      primaryAction: {
        content: isSaving ? "Saving…" : "Save settings",
        disabled: isSaving,
        onAction: () => {
          const el = document.getElementById("pixelpro-settings-form");
          if (el instanceof HTMLFormElement) el.requestSubmit();
        }
      },
      children: /* @__PURE__ */ jsxs(BlockStack, { gap: "500", children: [
        (actionData == null ? void 0 : actionData.ok) && /* @__PURE__ */ jsx(Banner, { tone: "success", onDismiss: () => {
        }, children: "Settings saved. Your pixels update on the storefront immediately." }),
        errors.form && /* @__PURE__ */ jsx(Banner, { tone: "critical", children: errors.form }),
        !isPro && /* @__PURE__ */ jsx(
          Banner,
          {
            title: "Unlock all 4 pixels with PixelPro",
            tone: "info",
            action: { content: "View plans", url: "/app/billing" },
            children: "The Free plan installs the Meta Pixel only. PixelPro adds TikTok, Google and Snapchat pixels — $12.99/month with a 7-day free trial."
          }
        ),
        /* @__PURE__ */ jsxs(Layout, { children: [
          /* @__PURE__ */ jsx(Layout.Section, { children: /* @__PURE__ */ jsx("form", { id: "pixelpro-settings-form", onSubmit: handleSubmit, children: /* @__PURE__ */ jsxs(BlockStack, { gap: "500", children: [
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
              /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Tracking status" }),
              /* @__PURE__ */ jsx(FormLayout, { children: /* @__PURE__ */ jsx(
                Checkbox,
                {
                  label: "Enable pixel tracking on the storefront",
                  checked: form.enabled,
                  onChange: (v) => set("enabled", v)
                }
              ) })
            ] }) }),
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
              /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Meta (Facebook) Pixel" }),
              /* @__PURE__ */ jsx(FormLayout, { children: /* @__PURE__ */ jsx(
                TextField,
                {
                  label: "Meta Pixel ID",
                  value: form.metaPixelId,
                  onChange: (v) => set("metaPixelId", v),
                  placeholder: "1683359659412165",
                  helpText: "Find it in Meta Events Manager → Data sources → your pixel. Digits only.",
                  autoComplete: "off",
                  error: errors.metaPixelId
                }
              ) })
            ] }) }),
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
              /* @__PURE__ */ jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [
                /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "TikTok Pixel" }),
                !isPro && /* @__PURE__ */ jsx(Badge, { tone: "info", children: "PixelPro" })
              ] }),
              /* @__PURE__ */ jsx(FormLayout, { children: /* @__PURE__ */ jsx(
                TextField,
                {
                  label: "TikTok Pixel ID",
                  value: form.tiktokPixelId,
                  onChange: (v) => set("tiktokPixelId", v),
                  placeholder: "D2ABCD1234EFGH5678",
                  helpText: "Find it in TikTok Events Manager → your pixel → Setup. Leave empty to skip.",
                  autoComplete: "off",
                  disabled: proLocked("tiktokPixelId"),
                  error: errors.tiktokPixelId
                }
              ) })
            ] }) }),
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
              /* @__PURE__ */ jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [
                /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Google Tag" }),
                !isPro && /* @__PURE__ */ jsx(Badge, { tone: "info", children: "PixelPro" })
              ] }),
              /* @__PURE__ */ jsx(FormLayout, { children: /* @__PURE__ */ jsx(
                TextField,
                {
                  label: "Google Tag ID",
                  value: form.googleTagId,
                  onChange: (v) => set("googleTagId", v),
                  placeholder: "G-XXXXXXXXXX or AW-XXXXXXXXXX",
                  helpText: "GA4 measurement ID (G-…) from Google Analytics, or Google Ads conversion ID (AW-…). Leave empty to skip.",
                  autoComplete: "off",
                  disabled: proLocked("googleTagId"),
                  error: errors.googleTagId
                }
              ) })
            ] }) }),
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
              /* @__PURE__ */ jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [
                /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Snapchat Pixel" }),
                !isPro && /* @__PURE__ */ jsx(Badge, { tone: "info", children: "PixelPro" })
              ] }),
              /* @__PURE__ */ jsx(FormLayout, { children: /* @__PURE__ */ jsx(
                TextField,
                {
                  label: "Snapchat Pixel ID",
                  value: form.snapchatPixelId,
                  onChange: (v) => set("snapchatPixelId", v),
                  placeholder: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                  helpText: "Find it in Snapchat Ads Manager → Events Manager → your pixel. Leave empty to skip.",
                  autoComplete: "off",
                  disabled: proLocked("snapchatPixelId"),
                  error: errors.snapchatPixelId
                }
              ) })
            ] }) })
          ] }) }) }),
          /* @__PURE__ */ jsx(Layout.Section, { variant: "oneThird", children: /* @__PURE__ */ jsxs(BlockStack, { gap: "500", children: [
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
              /* @__PURE__ */ jsxs(InlineStack, { align: "space-between", blockAlign: "center", children: [
                /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "App embed" }),
                embedEnabled ? /* @__PURE__ */ jsx(Badge, { tone: "success", children: "Enabled" }) : /* @__PURE__ */ jsx(Badge, { tone: "critical", children: "Not enabled" })
              ] }),
              /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: embedEnabled ? "PixelPro Tracking is active on your theme. Pixels fire on the storefront." : "Turn on the PixelPro Tracking embed in your theme editor to start firing pixels." }),
              /* @__PURE__ */ jsx(
                Button,
                {
                  url: `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/themes/current/editor?context=apps`,
                  target: "_blank",
                  children: embedEnabled ? "Open theme editor" : "Enable in theme editor"
                }
              )
            ] }) }),
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
              /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Storefront status" }),
              /* @__PURE__ */ jsx(PixelStatus, { settings: form })
            ] }) }),
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "300", children: [
              /* @__PURE__ */ jsx(InlineStack, { align: "space-between", blockAlign: "center", children: /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "Diagnostics" }) }),
              /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", tone: "subdued", children: "See live pixel events from your storefront and test each pixel." }),
              /* @__PURE__ */ jsx(Button, { url: "/app/diagnostics", children: "Open diagnostics" })
            ] }) }),
            /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "300", children: [
              /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "How to activate" }),
              /* @__PURE__ */ jsx(Divider, {}),
              /* @__PURE__ */ jsxs(BlockStack, { gap: "200", children: [
                /* @__PURE__ */ jsxs(Text, { as: "p", variant: "bodyMd", children: [
                  "1. In your theme editor, open",
                  " ",
                  /* @__PURE__ */ jsx("strong", { children: "Theme settings → App embeds" }),
                  "."
                ] }),
                /* @__PURE__ */ jsxs(Text, { as: "p", variant: "bodyMd", children: [
                  "2. Turn on ",
                  /* @__PURE__ */ jsx("strong", { children: "PixelPro Tracking" }),
                  " and save."
                ] }),
                /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", children: "3. Pixels fire PageView, ViewContent, AddToCart, InitiateCheckout and Purchase events automatically." })
              ] })
            ] }) })
          ] }) })
        ] })
      ] })
    }
  );
}
const route9 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  action,
  default: SettingsPage,
  loader: loader$3
}, Symbol.toStringTag, { value: "Module" }));
const polarisStyles = "/assets/styles-CV7GIAUv.css";
const links$1 = () => [{ rel: "stylesheet", href: polarisStyles }];
const loader$2 = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return login(request);
};
function Auth() {
  const [shop, setShop] = useState("");
  return /* @__PURE__ */ jsx(AppProvider, { i18n: {}, children: /* @__PURE__ */ jsx(Page, { children: /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsx(Form, { method: "post", children: /* @__PURE__ */ jsx(FormLayout, { children: /* @__PURE__ */ jsxs(BlockStack, { gap: "200", children: [
    /* @__PURE__ */ jsx(Text, { as: "h2", variant: "headingMd", children: "PixelPro — Multi Pixel Manager" }),
    /* @__PURE__ */ jsx(Text, { as: "p", variant: "bodyMd", children: "Log in to install the app on your store." }),
    /* @__PURE__ */ jsx(
      TextField,
      {
        label: "Shop domain",
        helpText: "Example: my-store.myshopify.com",
        value: shop,
        onChange: setShop,
        autoComplete: "off",
        name: "shop"
      }
    ),
    /* @__PURE__ */ jsx(Button, { submit: true, variant: "primary", children: "Log in" })
  ] }) }) }) }) }) });
}
const route10 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Auth,
  links: links$1,
  loader: loader$2
}, Symbol.toStringTag, { value: "Module" }));
const loader$1 = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};
const route11 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  loader: loader$1
}, Symbol.toStringTag, { value: "Module" }));
const links = () => [{ rel: "stylesheet", href: polarisStyles }];
const loader = async ({ request }) => {
  await authenticate.admin(request);
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
};
function App() {
  const { apiKey } = useLoaderData();
  return /* @__PURE__ */ jsxs(AppProvider$1, { isEmbeddedApp: true, apiKey, children: [
    /* @__PURE__ */ jsxs(NavMenu, { children: [
      /* @__PURE__ */ jsx(Link, { to: "/app", rel: "home", children: "Settings" }),
      /* @__PURE__ */ jsx(Link, { to: "/app/billing", children: "Billing" })
    ] }),
    /* @__PURE__ */ jsx(Outlet, {})
  ] });
}
function ErrorBoundary() {
  return boundary.error(useRouteError());
}
const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
const route12 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ErrorBoundary,
  default: App,
  headers,
  links,
  loader
}, Symbol.toStringTag, { value: "Module" }));
const serverManifest = { "entry": { "module": "/assets/entry.client-BeOE-d1E.js", "imports": ["/assets/components-DhY-WGTe.js"], "css": [] }, "routes": { "root": { "id": "root", "parentId": void 0, "path": "", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/root-DfcyJ4NM.js", "imports": ["/assets/components-DhY-WGTe.js"], "css": [] }, "routes/webhooks.customers.data_request": { "id": "routes/webhooks.customers.data_request", "parentId": "root", "path": "webhooks/customers/data_request", "index": void 0, "caseSensitive": void 0, "hasAction": true, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/webhooks.customers.data_request-l0sNRNKZ.js", "imports": [], "css": [] }, "routes/webhooks.app.scopes_update": { "id": "routes/webhooks.app.scopes_update", "parentId": "root", "path": "webhooks/app/scopes_update", "index": void 0, "caseSensitive": void 0, "hasAction": true, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/webhooks.app.scopes_update-l0sNRNKZ.js", "imports": [], "css": [] }, "routes/webhooks.customers.redact": { "id": "routes/webhooks.customers.redact", "parentId": "root", "path": "webhooks/customers/redact", "index": void 0, "caseSensitive": void 0, "hasAction": true, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/webhooks.customers.redact-l0sNRNKZ.js", "imports": [], "css": [] }, "routes/webhooks.app.uninstalled": { "id": "routes/webhooks.app.uninstalled", "parentId": "root", "path": "webhooks/app/uninstalled", "index": void 0, "caseSensitive": void 0, "hasAction": true, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/webhooks.app.uninstalled-l0sNRNKZ.js", "imports": [], "css": [] }, "routes/webhooks.shop.redact": { "id": "routes/webhooks.shop.redact", "parentId": "root", "path": "webhooks/shop/redact", "index": void 0, "caseSensitive": void 0, "hasAction": true, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/webhooks.shop.redact-l0sNRNKZ.js", "imports": [], "css": [] }, "routes/api.pixel-events": { "id": "routes/api.pixel-events", "parentId": "root", "path": "api/pixel-events", "index": void 0, "caseSensitive": void 0, "hasAction": true, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/api.pixel-events-l0sNRNKZ.js", "imports": [], "css": [] }, "routes/app.diagnostics": { "id": "routes/app.diagnostics", "parentId": "routes/app", "path": "diagnostics", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/app.diagnostics-ROgSqPsE.js", "imports": ["/assets/components-DhY-WGTe.js", "/assets/Page-BwWbnNu1.js", "/assets/Layout-U9DlrdpL.js", "/assets/context-DkEZvobt.js"], "css": [] }, "routes/app.billing": { "id": "routes/app.billing", "parentId": "routes/app", "path": "billing", "index": void 0, "caseSensitive": void 0, "hasAction": true, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/app.billing-bPKzJzqh.js", "imports": ["/assets/components-DhY-WGTe.js", "/assets/Page-BwWbnNu1.js", "/assets/Layout-U9DlrdpL.js", "/assets/Banner-BeCarsUe.js", "/assets/context-DkEZvobt.js"], "css": [] }, "routes/app._index": { "id": "routes/app._index", "parentId": "routes/app", "path": void 0, "index": true, "caseSensitive": void 0, "hasAction": true, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/app._index-BwTntW05.js", "imports": ["/assets/components-DhY-WGTe.js", "/assets/Page-BwWbnNu1.js", "/assets/Banner-BeCarsUe.js", "/assets/Layout-U9DlrdpL.js", "/assets/FormLayout-DRoOMqU-.js", "/assets/context-DkEZvobt.js"], "css": [] }, "routes/_index": { "id": "routes/_index", "parentId": "root", "path": void 0, "index": true, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/_index-CmxG3J36.js", "imports": ["/assets/components-DhY-WGTe.js", "/assets/styles-DyuxoJmC.js", "/assets/Page-BwWbnNu1.js", "/assets/FormLayout-DRoOMqU-.js", "/assets/context-DkEZvobt.js"], "css": [] }, "routes/auth.$": { "id": "routes/auth.$", "parentId": "root", "path": "auth/*", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": false, "module": "/assets/auth._-l0sNRNKZ.js", "imports": [], "css": [] }, "routes/app": { "id": "routes/app", "parentId": "root", "path": "app", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasErrorBoundary": true, "module": "/assets/app-BVQ8-x3x.js", "imports": ["/assets/components-DhY-WGTe.js", "/assets/styles-DyuxoJmC.js", "/assets/context-DkEZvobt.js"], "css": [] } }, "url": "/assets/manifest-d1513d20.js", "version": "d1513d20" };
const mode = "production";
const assetsBuildDirectory = "build/client";
const basename = "/";
const future = { "v3_fetcherPersist": true, "v3_relativeSplatPath": true, "v3_throwAbortReason": true, "v3_routeConfig": false, "v3_singleFetch": true, "v3_lazyRouteDiscovery": true, "unstable_optimizeDeps": false };
const isSpaMode = false;
const publicPath = "/";
const entry = { module: entryServer };
const routes = {
  "root": {
    id: "root",
    parentId: void 0,
    path: "",
    index: void 0,
    caseSensitive: void 0,
    module: route0
  },
  "routes/webhooks.customers.data_request": {
    id: "routes/webhooks.customers.data_request",
    parentId: "root",
    path: "webhooks/customers/data_request",
    index: void 0,
    caseSensitive: void 0,
    module: route1
  },
  "routes/webhooks.app.scopes_update": {
    id: "routes/webhooks.app.scopes_update",
    parentId: "root",
    path: "webhooks/app/scopes_update",
    index: void 0,
    caseSensitive: void 0,
    module: route2
  },
  "routes/webhooks.customers.redact": {
    id: "routes/webhooks.customers.redact",
    parentId: "root",
    path: "webhooks/customers/redact",
    index: void 0,
    caseSensitive: void 0,
    module: route3
  },
  "routes/webhooks.app.uninstalled": {
    id: "routes/webhooks.app.uninstalled",
    parentId: "root",
    path: "webhooks/app/uninstalled",
    index: void 0,
    caseSensitive: void 0,
    module: route4
  },
  "routes/webhooks.shop.redact": {
    id: "routes/webhooks.shop.redact",
    parentId: "root",
    path: "webhooks/shop/redact",
    index: void 0,
    caseSensitive: void 0,
    module: route5
  },
  "routes/api.pixel-events": {
    id: "routes/api.pixel-events",
    parentId: "root",
    path: "api/pixel-events",
    index: void 0,
    caseSensitive: void 0,
    module: route6
  },
  "routes/app.diagnostics": {
    id: "routes/app.diagnostics",
    parentId: "routes/app",
    path: "diagnostics",
    index: void 0,
    caseSensitive: void 0,
    module: route7
  },
  "routes/app.billing": {
    id: "routes/app.billing",
    parentId: "routes/app",
    path: "billing",
    index: void 0,
    caseSensitive: void 0,
    module: route8
  },
  "routes/app._index": {
    id: "routes/app._index",
    parentId: "routes/app",
    path: void 0,
    index: true,
    caseSensitive: void 0,
    module: route9
  },
  "routes/_index": {
    id: "routes/_index",
    parentId: "root",
    path: void 0,
    index: true,
    caseSensitive: void 0,
    module: route10
  },
  "routes/auth.$": {
    id: "routes/auth.$",
    parentId: "root",
    path: "auth/*",
    index: void 0,
    caseSensitive: void 0,
    module: route11
  },
  "routes/app": {
    id: "routes/app",
    parentId: "root",
    path: "app",
    index: void 0,
    caseSensitive: void 0,
    module: route12
  }
};
export {
  serverManifest as assets,
  assetsBuildDirectory,
  basename,
  entry,
  future,
  isSpaMode,
  mode,
  publicPath,
  routes
};
