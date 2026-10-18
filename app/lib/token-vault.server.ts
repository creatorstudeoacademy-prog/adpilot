/**
 * Server-only token vault for Meta OAuth tokens.
 *
 * Meta access tokens (user/page/ad-account) are encrypted at rest with the
 * same AES-256-GCM vault used for AI provider keys (see ai-providers.server.ts).
 *
 * Migration: rows written before encryption are plaintext. decryptToken()
 * detects the encrypted format ("iv:ciphertext:tag", lowercase hex) and
 * passes legacy plaintext through untouched, so old rows keep working until
 * they are re-saved (which re-encrypts them).
 */

import { decryptKey, encryptKey } from "./ai-providers.server";

// 12-byte IV : variable ciphertext : 16-byte auth tag (all lowercase hex).
const ENCRYPTED_RE = /^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/;

/** True when the stored value is vault-encrypted (not legacy plaintext). */
export function isEncryptedToken(stored: string | null | undefined): boolean {
  return ENCRYPTED_RE.test(String(stored ?? ""));
}

/** Encrypt a fresh plaintext token before writing it to the DB. */
export function encryptToken(plain: string): string {
  if (!plain) throw new Error("Cannot encrypt an empty token.");
  return encryptKey(plain);
}

/**
 * Decrypt a stored token for use. Legacy plaintext rows are returned as-is.
 * Safe to call on any value read from the accessToken columns.
 */
export function decryptToken(stored: string | null | undefined): string {
  const value = String(stored ?? "");
  if (!value) return value;
  if (!isEncryptedToken(value)) return value; // legacy plaintext row
  return decryptKey(value);
}
