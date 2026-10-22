import { test } from "node:test";
import assert from "node:assert/strict";
import { propose, MIN_STOP_PCT } from "./proposer.ts";
import type { Candle } from "../strike/types.ts";

function trend(n: number, drift: number, noise = 0.0015): Candle[] {
  const out: Candle[] = [];
  let p = 2400;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const t0 = Date.now() - (n + 1) * 300_000;
  for (let i = 0; i < n; i++) {
    const o = p;
    p *= 1 + drift + rnd() * noise;
    out.push({ openTime: t0 + i * 300_000, open: o, high: Math.max(o, p) * 1.0002, low: Math.min(o, p) * 0.9998, close: p, volume: 1 + i / n, closeTime: t0 + (i + 1) * 300_000 - 1 });
  }
  return out;
}

test("quiet uptrend: stop is floored at 0.35% even when ATR is tiny", () => {
  const p = propose("ETH-USD", "5m", trend(200, 0.0001));
  assert.ok(p, "expected a long proposal");
  assert.equal(p!.side, "long");
  const stopPct = (p!.entry - p!.stopLoss) / p!.entry;
  assert.ok(stopPct >= MIN_STOP_PCT - 1e-9, `stop ${stopPct}`);
  const rr = (p!.takeProfit - p!.entry) / (p!.entry - p!.stopLoss);
  assert.ok(Math.abs(rr - 2) < 1e-6);
});

test("deterministic id per symbol/side/candle", () => {
  const c = trend(200, 0.0001);
  assert.equal(propose("ETH-USD", "5m", c)?.id, propose("ETH-USD", "5m", c)?.id);
});

test("too little history → no proposal", () => {
  assert.equal(propose("ETH-USD", "5m", trend(40, 0.001)), null);
});

test("1.5×ATR below the floor: the floor wins (the ETH 0.14% case)", () => {
  const p = propose("ETH-USD", "5m", trend(200, 0.0001))!;
  assert.ok(1.5 * p.features.atrPct < MIN_STOP_PCT * 100, "fixture must have tiny ATR");
  assert.ok(Math.abs((p.entry - p.stopLoss) / p.entry - MIN_STOP_PCT) < 1e-6);
});
