/** Check the configured explainer (Claude or OpenAI) with a sample BLOCK decision. `npm run explain:test` */
import "dotenv/config";
import { explain, explainerSource } from "../lib/ai/explainer.ts";
import { evaluate } from "../lib/guardian/engine.ts";

const market: any = { symbol: "BTC-USD", status: "trading", reduce_only: false, margin_tiers: [{ max_notional: "500000", max_leverage: 100, maintenance_margin_rate: "0.005", maintenance_amount: "0" }], order_tick_price: "1", order_min_price: "1", order_market_step_size: "0.00001", order_market_min_size: "0.00001", order_min_notional: "10", funding_rate: "0", default_leverage: 10, mark_price: "81900" };
const proposal: any = { id: "demo", symbol: "BTC-USD", side: "long", interval: "5m", candleTime: 0, entry: 81900, stopLoss: 81900 * 0.996, takeProfit: 81900 * 1.008, confidence: 0.52, features: {}, thesis: "BTC-USD long: demo" };
const d = evaluate({ proposal, market, depth: { lastUpdateId: 0, E: 0, T: 0, bids: [["81899", "1"]], asks: [["81901", "1"]] }, equity: 15, available: 15, positions: [], risk: { dayStartEquity: 15, consecutiveLosses: 0, lastLossAt: null }, now: Date.now() });
console.log(`configured: ${explainerSource()}  ·  verdict: ${d.verdict}`);
const e = await explain(d, proposal);
console.log(`source: ${e.source}${e.fallbackReason ? `  ·  FELL BACK: ${e.fallbackReason}` : ""}\n\n${e.text}\n`);
