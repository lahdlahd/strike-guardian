import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMessage,
  bodyHash,
  EMPTY_BODY_HASH,
  generateKeys,
  normalizePrivateKey,
  publicKeyFromPrivate,
  signRequest,
  verifySignature,
} from "./auth.ts";

// RFC 8032 test vector 1 (empty message) — proves our Ed25519 wiring is standard.
const RFC_SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PK = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

test("RFC 8032 vector: public key derivation", () => {
  assert.equal(publicKeyFromPrivate(RFC_SK), RFC_PK);
});

test("empty body hashes to the documented constant", () => {
  assert.equal(bodyHash(""), EMPTY_BODY_HASH);
});

test("message format matches Strike spec", () => {
  const msg = buildMessage("get", "/v2/positions?symbol=BTC-USD", 1704067200, "550e8400-e29b-41d4-a716-446655440000", "");
  assert.equal(msg, `GET:/v2/positions?symbol=BTC-USD:1704067200:550e8400-e29b-41d4-a716-446655440000:${EMPTY_BODY_HASH}`);
});

test("signed headers verify against the rebuilt message", () => {
  const keys = generateKeys();
  const body = JSON.stringify({ symbol: "BTC-USD", side: "buy", type: "market", size: "0.001" });
  const h = signRequest(keys, "POST", "/v2/order", body);
  const msg = buildMessage("POST", "/v2/order", Number(h["X-API-Wallet-Timestamp"]), h["X-API-Wallet-Nonce"], body);
  assert.equal(h["X-API-Wallet-Public-Key"].length, 64);
  assert.equal(h["X-API-Wallet-Signature"].length, 128);
  assert.ok(verifySignature(keys.publicKey, msg, h["X-API-Wallet-Signature"]));
  // tampered body must fail
  const bad = buildMessage("POST", "/v2/order", Number(h["X-API-Wallet-Timestamp"]), h["X-API-Wallet-Nonce"], body + " ");
  assert.equal(verifySignature(keys.publicKey, bad, h["X-API-Wallet-Signature"]), false);
});

test("timestamp is never in the future", () => {
  const h = signRequest(generateKeys(), "GET", "/v2/account");
  assert.ok(Number(h["X-API-Wallet-Timestamp"]) <= Math.floor(Date.now() / 1000));
});

test("64-byte expanded private key is truncated to seed", () => {
  const expanded = RFC_SK + RFC_PK;
  assert.equal(Buffer.from(normalizePrivateKey(expanded)).toString("hex"), RFC_SK);
});

test("nonces are unique", () => {
  const k = generateKeys();
  const a = signRequest(k, "GET", "/v2/account")["X-API-Wallet-Nonce"];
  const b = signRequest(k, "GET", "/v2/account")["X-API-Wallet-Nonce"];
  assert.notEqual(a, b);
});
