import { test } from "node:test";
import assert from "node:assert/strict";
import { GENESIS, signArtifact, verifyArtifact } from "./artifact.ts";
import { generateKeys } from "../strike/auth.ts";

const k = generateKeys();
const base = (seq: number, prevHash: string) => ({
  v: 1 as const, kind: "decision" as const, seq, prevHash, createdAt: 1792664110684, network: "mainnet",
  attestPubKey: k.publicKey, symbol: "BTC-USD", verdict: "BLOCK", body: { reason: "confidence 0.52 < 0.6", x: [1, 2, { b: 2, a: 1 }] },
});

test("signed artifact verifies; survives a JSON round-trip (DB storage)", () => {
  const a = signArtifact(base(1, GENESIS), k.privateKey);
  assert.deepEqual(verifyArtifact(a), { hashOk: true, signatureOk: true });
  const roundTrip = JSON.parse(JSON.stringify(a));
  assert.deepEqual(verifyArtifact(roundTrip), { hashOk: true, signatureOk: true });
});

test("tampering with the verdict breaks the hash", () => {
  const a = signArtifact(base(1, GENESIS), k.privateKey);
  const forged = { ...a, verdict: "APPROVE" };
  assert.equal(verifyArtifact(forged).hashOk, false);
});

test("re-hashing a forgery without the key breaks the signature", () => {
  const a = signArtifact(base(1, GENESIS), k.privateKey);
  const other = generateKeys();
  const forged = signArtifact({ ...base(1, GENESIS), verdict: "APPROVE" }, other.privateKey);
  assert.equal(verifyArtifact({ ...forged, attestPubKey: a.attestPubKey, hash: forged.hash }).signatureOk, false);
});

test("chain: deleted or reordered artifacts are detected", () => {
  const a1 = signArtifact(base(1, GENESIS), k.privateKey);
  const a2 = signArtifact(base(2, a1.hash), k.privateKey);
  const a3 = signArtifact(base(3, a2.hash), k.privateKey);
  assert.equal(verifyArtifact(a2, a1).chainOk, true);
  assert.equal(verifyArtifact(a3, a1).chainOk, false); // a2 removed
});
