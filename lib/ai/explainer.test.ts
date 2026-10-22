import { test } from "node:test";
import assert from "node:assert/strict";
import { explain } from "./explainer.ts";

const d: any = { verdict: "BLOCK", passed: 12, total: 13, plan: null, checks: [{ id: "confidence", name: "Signal confidence", passed: false, critical: true, value: "0.52", threshold: "≥ 0.6", detail: "" }] };
const p: any = { symbol: "BTC-USD", side: "long", entry: 81900, stopLoss: 81600, takeProfit: 82500, confidence: 0.52, thesis: "t" };

function withEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch, fn: () => Promise<void>) {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  globalThis.fetch = fetchImpl;
  return fn().finally(() => {
    process.env = saved;
    globalThis.fetch = savedFetch;
  });
}
const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("OpenAI: reads output_text", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "some-model" }, json({ output_text: "Blocked: confidence too low." }), async () => {
    const e = await explain(d, p);
    assert.equal(e.source, "some-model");
    assert.equal(e.text, "Blocked: confidence too low.");
  }));

test("OpenAI: reads message → output_text content blocks", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "m" }, json({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "Two sentences." }] }] }), async () => {
    assert.equal((await explain(d, p)).text, "Two sentences.");
  }));

test("OpenAI quota error → template, with reason, never leaking the key", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-secret-123", OPENAI_MODEL: "m" }, json({ error: { message: "quota exceeded" } }, 429), async () => {
    const e = await explain(d, p);
    assert.equal(e.source, "template");
    assert.match(e.fallbackReason ?? "", /429/);
    assert.doesNotMatch(JSON.stringify(e), /sk-secret-123/);
    assert.match(e.text, /signal confidence/);
  }));

test("OPENAI_API_KEY without OPENAI_MODEL → template (no guessed model ids)", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: undefined }, json({}), async () => {
    assert.equal((await explain(d, p)).source, "template");
  }));
