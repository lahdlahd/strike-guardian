/**
 * Strike market math: grid rounding, book walking, isolated liquidation estimate.
 * Grids are anchored at the market minimum: value = min + k × step.
 */

import type { DepthResponse, Market } from "../strike/types.ts";

function decimals(step: string): number {
  const s = step.includes("e-") ? Number(step).toFixed(20).replace(/0+$/, "") : step;
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Round DOWN onto the size grid (never exceed what we sized). */
export function floorSize(size: number, market: Market): string {
  const min = Number(market.order_market_min_size);
  const step = Number(market.order_market_step_size) || min;
  if (size < min) return "0";
  const k = Math.floor((size - min) / step + 1e-9);
  return (min + k * step).toFixed(decimals(market.order_market_step_size || market.order_market_min_size));
}

/** Smallest grid size whose notional meets order_min_notional at `price`. */
export function minTradableSize(market: Market, price: number): string {
  const min = Number(market.order_market_min_size);
  const step = Number(market.order_market_step_size) || min;
  const minNotional = Number(market.order_min_notional) || 0;
  let k = Math.max(0, Math.ceil((minNotional / price - min) / step - 1e-9));
  let size = min + k * step;
  if (size * price < minNotional) size += step; // float safety
  return size.toFixed(decimals(market.order_market_step_size || market.order_market_min_size));
}

/** Round a trigger price onto the tick grid, toward `toward` (conservative: tighter stop / nearer target). */
export function tickPrice(price: number, market: Market, toward: number): string {
  const tick = Number(market.order_tick_price);
  const base = Number(market.order_min_price) || 0;
  const k = (price - base) / tick;
  const rounded = base + (toward > price ? Math.ceil(k - 1e-9) : Math.floor(k + 1e-9)) * tick;
  return rounded.toFixed(Math.max(decimals(market.order_tick_price), 0));
}

export interface BookWalk {
  mid: number;
  spreadPct: number;
  avgFill: number;
  slippagePct: number; // avg fill vs mid, positive = worse
  filled: boolean; // book deep enough for the size
}

export function walkBook(depth: DepthResponse, side: "buy" | "sell", size: number): BookWalk {
  const bestBid = Number(depth.bids[0]?.[0]);
  const bestAsk = Number(depth.asks[0]?.[0]);
  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = ((bestAsk - bestBid) / mid) * 100;
  const levels = side === "buy" ? depth.asks : depth.bids;
  let remaining = size;
  let cost = 0;
  for (const [p, q] of levels) {
    const take = Math.min(remaining, Number(q));
    cost += take * Number(p);
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  const filledQty = size - Math.max(remaining, 0);
  const avgFill = filledQty > 0 ? cost / filledQty : NaN;
  const slippagePct = Number.isFinite(avgFill) ? ((side === "buy" ? avgFill - mid : mid - avgFill) / mid) * 100 : Infinity;
  return { mid, spreadPct, avgFill, slippagePct, filled: remaining <= 1e-12 };
}

/** Maintenance margin rate for a notional (first tier whose max_notional covers it). */
export function mmrFor(market: Market, notional: number): { mmr: number; maxLeverage: number } {
  const tiers = market.margin_tiers ?? [];
  const t = tiers.find((x) => notional <= Number(x.max_notional)) ?? tiers[tiers.length - 1];
  return { mmr: Number(t?.maintenance_margin_rate ?? 0.01), maxLeverage: t?.max_leverage ?? market.default_leverage };
}

/** Isolated-margin liquidation estimate (ignores fees/funding, so it is slightly optimistic — the buffer check covers that). */
export function isolatedLiqPrice(entry: number, side: "long" | "short", leverage: number, mmr: number): number {
  return side === "long" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}
