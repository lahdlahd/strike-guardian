import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "./ledger.ts";
import { verifyArtifact, type Artifact } from "./artifact.ts";
import { generateKeys } from "../strike/auth.ts";
import type { Store } from "./store.ts";

class MemStore implements Store {
  rows: Artifact[] = [];
  state: Record<string, unknown> = {};
  async init() {}
  async append(a: Artifact) {
    await new Promise((r) => setTimeout(r, Math.random() * 5)); // jitter to provoke races
    this.rows.push(a);
  }
  async last() { return this.rows.at(-1) ?? null; }
  async list() { return [...this.rows].reverse(); }
  async getState<T>(k: string) { return (this.state[k] as T) ?? null; }
  async setState(k: string, v: unknown) { this.state[k] = v; }
  async close() {}
}

test("50 concurrent writes (agent loop + async explanations) keep a perfect chain", async () => {
  const k = generateKeys();
  const store = new MemStore();
  const L = new Ledger(store, k.privateKey, k.publicKey, "test");
  await L.init();
  await Promise.all(Array.from({ length: 50 }, (_, i) => L.write(i % 3 ? "decision" : "explanation", { i })));
  await L.drain();
  assert.equal(store.rows.length, 50);
  store.rows.forEach((a, i) => {
    assert.equal(a.seq, i + 1);
    const v = verifyArtifact(a, i ? store.rows[i - 1] : undefined);
    assert.ok(v.hashOk && v.signatureOk && (v.chainOk ?? true), `seq ${a.seq}`);
  });
});

test("a failed write doesn't wedge the queue", async () => {
  const k = generateKeys();
  const store = new MemStore();
  let fail = true;
  const orig = store.append.bind(store);
  store.append = async (a) => { if (fail) { fail = false; throw new Error("db down"); } return orig(a); };
  const L = new Ledger(store, k.privateKey, k.publicKey, "test");
  await L.init();
  await assert.rejects(() => L.write("decision", { n: 1 }));
  const a = await L.write("decision", { n: 2 });
  assert.equal(a.seq, 1, "seq not advanced by the failed write");
});
