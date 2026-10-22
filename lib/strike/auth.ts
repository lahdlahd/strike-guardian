/**
 * Strike API-wallet request signing (Ed25519).
 *
 * Message:  {METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}
 *   PATH       path + "?" + raw query when a query string exists
 *   TIMESTAMP  unix SECONDS, must not be in the future and ≤ 3 min old
 *   NONCE      16..128 chars, single use per key (UUID v4)
 *   BODY_HASH  hex SHA-256 of the exact body bytes sent ("" for GET)
 *
 * Clock drift (WSL is notorious for it) is handled with a server-time offset
 * from GET /v2/time instead of trusting the local clock.
 *
 * API-wallet keys can trade but CANNOT withdraw or deposit.
 */

import * as ed from "@noble/ed25519";
import { sha512, sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { randomUUID } from "node:crypto";

// @noble/ed25519 v3: sync sign/verify need sha512 wired in explicitly.
ed.hashes.sha512 = sha512;

export interface ApiWalletKeys {
  publicKey: string; // 64 hex (32-byte raw Ed25519)
  privateKey: string; // 64 hex seed (128 hex expanded is accepted and truncated)
}

export const EMPTY_BODY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function generateKeys(): ApiWalletKeys {
  const secret = ed.utils.randomSecretKey();
  return {
    privateKey: bytesToHex(secret),
    publicKey: bytesToHex(ed.getPublicKey(secret)),
  };
}

export function normalizePrivateKey(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(clean)) throw new Error("Private key must be hex");
  const bytes = hexToBytes(clean);
  if (bytes.length === 64) return bytes.subarray(0, 32);
  if (bytes.length !== 32) throw new Error(`Private key must be 32 or 64 bytes, got ${bytes.length}`);
  return bytes;
}

export function publicKeyFromPrivate(privateKeyHex: string): string {
  return bytesToHex(ed.getPublicKey(normalizePrivateKey(privateKeyHex)));
}

export function bodyHash(body: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(body)));
}

export function buildMessage(
  method: string,
  pathWithQuery: string,
  timestamp: number,
  nonce: string,
  body: string
): string {
  return `${method.toUpperCase()}:${pathWithQuery}:${timestamp}:${nonce}:${bodyHash(body)}`;
}

/** Seconds to ADD to the local clock to match Strike's server clock. */
let serverOffsetSec = 0;
export function setServerOffset(offsetSec: number) {
  serverOffsetSec = offsetSec;
}
export function getServerOffset(): number {
  return serverOffsetSec;
}

export interface SignOptions {
  /** Override for deterministic tests. */
  timestamp?: number;
  nonce?: string;
}

export function signRequest(
  keys: ApiWalletKeys,
  method: string,
  pathWithQuery: string,
  body = "",
  opts: SignOptions = {}
): Record<string, string> {
  // Never sign a future timestamp: use server-adjusted time minus a 1s safety margin
  // (the server allows up to 3 minutes of age, so 1s costs nothing).
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000 + serverOffsetSec) - 1;
  const nonce = opts.nonce ?? randomUUID();
  const message = buildMessage(method, pathWithQuery, timestamp, nonce, body);
  const signature = ed.sign(new TextEncoder().encode(message), normalizePrivateKey(keys.privateKey));
  return {
    "X-API-Wallet-Public-Key": keys.publicKey.toLowerCase(),
    "X-API-Wallet-Signature": bytesToHex(signature),
    "X-API-Wallet-Timestamp": String(timestamp),
    "X-API-Wallet-Nonce": nonce,
  };
}

export function verifySignature(publicKeyHex: string, message: string, signatureHex: string): boolean {
  return ed.verify(hexToBytes(signatureHex), new TextEncoder().encode(message), hexToBytes(publicKeyHex));
}

export function loadKeysFromEnv(): ApiWalletKeys | null {
  const priv = process.env.STRIKE_API_PRIVATE_KEY?.trim();
  if (!priv) return null;
  const derived = publicKeyFromPrivate(priv);
  const declared = process.env.STRIKE_API_PUBLIC_KEY?.trim().toLowerCase();
  if (declared && declared !== derived) {
    throw new Error(
      "STRIKE_API_PUBLIC_KEY does not match the key derived from STRIKE_API_PRIVATE_KEY. " +
        "Check .env for a copy-paste error (stray space/newline is the usual culprit)."
    );
  }
  return { privateKey: priv, publicKey: derived };
}
