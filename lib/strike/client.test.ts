import { test } from "node:test";
import assert from "node:assert/strict";
import { StrikeClient } from "./client.ts";
import { generateKeys } from "./auth.ts";

function mockFetch(responses: (() => Response | never)[]) {
  const calls: { url: string; nonce?: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, nonce: (init.headers as Record<string, string>)["X-API-Wallet-Nonce"] });
    const next = responses.shift();
    if (!next) throw new Error("no more mocked responses");
    return next();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}
const netErr = () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
};
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

test("reads retry through transient network errors, re-signing each attempt", async () => {
  const m = mockFetch([netErr, netErr, ok({ wallet_balance: "15" })]);
  try {
    const c = new StrikeClient({ keys: generateKeys(), network: "mainnet" });
    const a = await c.account();
    assert.equal(a.wallet_balance, "15");
    assert.equal(m.calls.length, 3);
    assert.equal(new Set(m.calls.map((x) => x.nonce)).size, 3, "fresh nonce per attempt");
  } finally {
    m.restore();
  }
});

test("orders are NEVER auto-retried (no double fills)", async () => {
  const m = mockFetch([netErr, ok({ sequence_id: 1, message_id: "x" })]);
  try {
    const c = new StrikeClient({ keys: generateKeys(), network: "mainnet" });
    await assert.rejects(() => c.placeOrder({ symbol: "BTC-USD", side: "buy", type: "market", size: "0.0002" }), /ECONNRESET/);
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test("error messages carry the underlying network cause", async () => {
  const m = mockFetch([netErr, netErr, netErr, netErr]);
  try {
    const c = new StrikeClient({ network: "mainnet" });
    await assert.rejects(() => c.markets(), /GET \/v2\/markets: fetch failed · ECONNRESET/);
  } finally {
    m.restore();
  }
});
