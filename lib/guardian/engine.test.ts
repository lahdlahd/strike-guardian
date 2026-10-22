import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type GuardianContext } from "./engine.ts";
import { floorSize, minTradableSize, tickPrice, walkBook } from "./market-math.ts";
import type { DepthResponse, Market } from "../strike/types.ts";
import type { TradeProposal } from "../strategy/proposer.ts";

// Shaped on live mainnet BTC-USD from the Phase 0 smoke test.
const BTC: Market = {
  symbol: "BTC-USD", base_asset: "BTC", status: "trading", base_prec: 5, quote_prec: 0, default_leverage: 10,
  margin_tiers: [
    { max_notional: "500000", max_leverage: 100, maintenance_margin_rate: "0.005", maintenance_amount: "0" },
    { max_notional: "5000000", max_leverage: 50, maintenance_margin_rate: "0.01", maintenance_amount: "2500" },
  ],
  reduce_only: false, order_tick_price: "1", order_min_price: "1", order_limit_price_bound: "0.05", order_market_price_bound: "0.05",
  order_market_step_size: "0.00001", order_market_min_size: "0.00001", order_market_max_size: "100",
  order_limit_step_size: "0.00001", order_limit_min_size: "0.00001", order_min_notional: "10",
  liquidation_fee_rate: "0.005", mark_price: "81919", index_price: "81958", last_price: "81919",
  bid1_price: "81919", bid1_size: "1", ask1_price: "81921", ask1_size: "1", funding_rate: "-0.000048", next_funding_time: 0,
};

const deepBook: DepthResponse = {
  lastUpdateId: 1, E: 0, T: 0,
  bids: [["81919", "0.5"], ["81915", "1"], ["81900", "2"]],
  asks: [["81921", "0.5"], ["81925", "1"], ["81940", "2"]],
};

const proposal = (o: Partial<TradeProposal> = {}): TradeProposal => ({
  id: "p1", symbol: "BTC-USD", side: "long", interval: "5m", candleTime: 0,
  entry: 81920, stopLoss: 81920 * (1 - 0.006), takeProfit: 81920 * (1 + 0.012), confidence: 0.72,
  features: { emaFast: 0, emaSlow: 0, rsi: 60, atr: 0, atrPct: 0, trendGapPct: 0, volumeRatio: 1 },
  thesis: "test", ...o,
});

const ctx = (o: Partial<GuardianContext> = {}): GuardianContext => ({
  proposal: proposal(), market: BTC, depth: deepBook, equity: 15, available: 15, positions: [],
  risk: { dayStartEquity: 15, consecutiveLosses: 0, lastLossAt: null }, now: 1_000_000, ...o,
});

test("grid math: min tradable BTC for $10 notional", () => {
  const s = minTradableSize(BTC, 81920);
  assert.ok(Number(s) * 81920 >= 10, `${s} must clear $10`);
  assert.ok((Number(s) - 0.00001) * 81920 < 10, "must be the smallest such size");
  assert.equal(floorSize(0.000127, BTC), "0.00012");
  assert.equal(tickPrice(81431.4, BTC, 81920), "81432"); // stop rounds toward entry (tighter)
});

test("healthy BTC long on a $15 account is APPROVED and sized within every limit", () => {
  const d = evaluate(ctx());
  assert.equal(d.verdict, "APPROVE", JSON.stringify(d.checks.filter((c) => !c.passed), null, 1));
  assert.ok(d.plan);
  assert.ok(d.plan!.notionalUsd >= 10, "meets exchange minimum");
  assert.ok(d.plan!.notionalUsd <= 45 + 1e-6, "≤ 3x account leverage");
  assert.ok(d.plan!.riskUsd <= 0.15 + 1e-9, "≤ 1% of equity at risk");
  assert.equal(d.total, 13);
});

test("low confidence is BLOCKED", () => {
  const d = evaluate(ctx({ proposal: proposal({ confidence: 0.5 }) }));
  assert.equal(d.verdict, "BLOCK");
  assert.equal(d.checks.find((c) => c.id === "confidence")!.passed, false);
  assert.equal(d.plan, null);
});

test("non-whitelisted wide-spread market (NIGHT-style) is BLOCKED on market + slippage", () => {
  const night: Market = { ...BTC, symbol: "NIGHT-USD", order_market_min_size: "1", order_market_step_size: "1", order_tick_price: "0.00000001", order_min_price: "0.00000001" };
  const wide: DepthResponse = { lastUpdateId: 1, E: 0, T: 0, bids: [["0.0396", "5000"]], asks: [["0.0400", "5000"]] };
  const d = evaluate(ctx({ market: night, depth: wide, proposal: proposal({ symbol: "NIGHT-USD", entry: 0.0398, stopLoss: 0.0398 * 0.99, takeProfit: 0.0398 * 1.02 }) }));
  assert.equal(d.verdict, "BLOCK");
  assert.equal(d.checks.find((c) => c.id === "market")!.passed, false);
  assert.equal(d.checks.find((c) => c.id === "slippage")!.passed, false);
});

test("a stop so wide that even Strike's minimum order breaches the risk budget is BLOCKED", () => {
  const d = evaluate(ctx({ proposal: proposal({ stopLoss: 81920 * (1 - 0.025), takeProfit: 81920 * 1.05 }) }));
  const risk = d.checks.find((c) => c.id === "risk")!;
  assert.equal(d.verdict, "BLOCK");
  assert.equal(risk.passed, false);
  assert.match(risk.detail, /Strike's minimum/);
});

test("second long while already long is BLOCKED on correlation", () => {
  const pos = [{ symbol: "ETH-USD", size: "0.004", entry_price: "2400" } as any];
  const d = evaluate(ctx({ positions: pos }));
  assert.equal(d.verdict, "BLOCK");
  assert.equal(d.checks.find((c) => c.id === "exposure")!.passed, false);
});

test("two recent losses PAUSE trading", () => {
  const d = evaluate(ctx({ risk: { dayStartEquity: 15, consecutiveLosses: 2, lastLossAt: 1_000_000 - 10 * 60_000 } }));
  assert.equal(d.verdict, "PAUSE");
});

test("daily loss limit PAUSES trading", () => {
  const d = evaluate(ctx({ equity: 14.0, available: 14.0, risk: { dayStartEquity: 15, consecutiveLosses: 0, lastLossAt: null } }));
  assert.equal(d.verdict, "PAUSE");
});

test("determinism: same inputs → identical decision", () => {
  assert.deepEqual(evaluate(ctx()), evaluate(ctx()));
});

test("book walk reports thin books as unfillable", () => {
  const w = walkBook({ lastUpdateId: 0, E: 0, T: 0, bids: [["100", "1"]], asks: [["101", "1"]] }, "buy", 5);
  assert.equal(w.filled, false);
});
