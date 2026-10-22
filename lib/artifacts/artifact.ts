/**
 * Signed, hash-chained artifacts.
 *
 *   hash      = sha256(canonicalJson(artifact without hash & signature))
 *   signature = Ed25519(attestKey, utf8(hash))
 *   prevHash  = hash of the previous artifact → tamper-evident chain
 *
 * The attestation key is SEPARATE from the trading key: it can sign receipts
 * but cannot touch the Strike account. Its public key is published in every
 * artifact so anyone can verify (the dashboard does it in the browser).
 *
 * Execution artifacts carry Strike's sequence_id / message_id, tying our log
 * to the Strike Node's own ordered message log.
 */

import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "../util/canonical.ts";

ed.hashes.sha512 = sha512;

export type ArtifactKind = "boot" | "decision" | "explanation" | "execution" | "outcome" | "kill" | "error";

export interface Artifact<B = Record<string, unknown>> {
  v: 1;
  kind: ArtifactKind;
  seq: number;
  prevHash: string;
  createdAt: number;
  network: string;
  attestPubKey: string;
  symbol?: string;
  verdict?: string;
  body: B;
  strike?: { sequence_id?: number; message_id?: string; client_order_id?: string; strategy_id?: string };
  hash: string;
  signature: string;
}

export const GENESIS = "0".repeat(64);

function seed(hex: string): Uint8Array {
  const b = hexToBytes(hex.trim().toLowerCase().replace(/^0x/, ""));
  return b.length === 64 ? b.subarray(0, 32) : b;
}

export function hashArtifact(a: Omit<Artifact, "hash" | "signature">): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(a))));
}

export function signArtifact(unsigned: Omit<Artifact, "hash" | "signature">, attestPrivateKey: string): Artifact {
  const hash = hashArtifact(unsigned);
  const signature = bytesToHex(ed.sign(new TextEncoder().encode(hash), seed(attestPrivateKey)));
  return { ...unsigned, hash, signature } as Artifact;
}

export interface VerifyResult {
  hashOk: boolean;
  signatureOk: boolean;
  chainOk?: boolean;
}

export function verifyArtifact(a: Artifact, prev?: Artifact): VerifyResult {
  const { hash, signature, ...rest } = a;
  const hashOk = hashArtifact(rest) === hash;
  let signatureOk = false;
  try {
    signatureOk = ed.verify(hexToBytes(signature), new TextEncoder().encode(hash), hexToBytes(a.attestPubKey));
  } catch {
    signatureOk = false;
  }
  return { hashOk, signatureOk, ...(prev ? { chainOk: a.prevHash === prev.hash && a.seq === prev.seq + 1 } : {}) };
}
