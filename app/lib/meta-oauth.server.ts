import { createHmac, timingSafeEqual } from "crypto";

/**
 * Signs the Facebook-connect initiation so the OAuth flow can run in a
 * top-level browser tab (Facebook blocks iframes) WITHOUT requiring a fresh
 * Shopify admin session in that tab.
 *
 * The signature is created server-side in an authenticated loader
 * (app.accounts.tsx), so only a logged-in merchant can mint a connect URL
 * for their own shop. The new tab then verifies the HMAC instead of calling
 * shopify.authenticate.admin().
 */

const EXPIRY_MS = 60 * 60 * 1000; // 60 minutes — page may sit open a while before click

function secret(): string {
  const s = process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET is not set");
  return s;
}

function sign(shop: string, ts: string): string {
  return createHmac("sha256", secret()).update(`${shop}.${ts}`).digest("hex");
}

/** Build the signed query string for /auth/meta. */
export function createMetaConnectParams(shop: string): string {
  const ts = String(Date.now());
  const sig = sign(shop, ts);
  const params = new URLSearchParams({ shop, ts, sig });
  return params.toString();
}

/** Verify the signed query string. Returns the shop, or null if invalid/expired. */
export function verifyMetaConnectParams(
  params: URLSearchParams,
): string | null {
  const shop = params.get("shop") ?? "";
  const ts = params.get("ts") ?? "";
  const sig = params.get("sig") ?? "";
  if (!shop || !ts || !sig) return null;
  if (!/^\d+$/.test(ts)) return null;
  if (Date.now() - Number(ts) > EXPIRY_MS) return null;

  const expected = sign(shop, ts);
  try {
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return shop;
}

interface MetaState {
  shop: string;
  ts: string;
  sig: string;
}

/** Encode the signed bundle as the Facebook `state` param (returned verbatim). */
export function encodeMetaState(shop: string, ts: string, sig: string): string {
  const payload: MetaState = { shop, ts, sig };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode + verify the Facebook `state` param. Returns the shop, or null. */
export function verifyMetaState(state: string | null): string | null {
  if (!state) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(state, "base64url").toString("utf8"),
    ) as MetaState;
    const params = new URLSearchParams({
      shop: payload.shop ?? "",
      ts: payload.ts ?? "",
      sig: payload.sig ?? "",
    });
    return verifyMetaConnectParams(params);
  } catch {
    return null;
  }
}
