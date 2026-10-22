/**
 * Proposer — a deliberately EAGER trend/momentum strategy on closed candles.
 *
 * It proposes whenever a setup scores ≥ PROPOSE_FLOOR, which is below the
 * Guardian's confidence bar on purpose: the proposer is aggressive, the Guardian
 * is conservative, and the dashboard shows the gap between them.
 *
 * Deterministic: same candles in → same proposal out.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Candle } from "../strike/types.ts";
import { atr, ema, rsi } from "./indicators.ts";

export const PROPOSE_FLOOR = 0.45;
export const MIN_STOP_PCT = 0.0035; // 0.35%

export interface TradeProposal {
  id: string; // deterministic: hash(symbol, side, candle time)
  symbol: string;
  side: "long" | "short";
  interval: string;
  candleTime: number; // open time of the signal candle
  entry: number; // reference price (last close)
  stopLoss: number;
  takeProfit: number;
  confidence: number; // 0..1
  features: {
    emaFast: number;
    emaSlow: number;
    rsi: number;
    atr: number;
    atrPct: number;
    trendGapPct: number;
    volumeRatio: number;
  };
  thesis: string; // one deterministic sentence
}

const r = (x: number, d = 6) => Number(x.toFixed(d));

export function propose(symbol: string, interval: string, candlesIn: Candle[]): TradeProposal | null {
  // Only closed candles: the last row may be in progress.
  const now = Date.now();
  const candles = candlesIn.filter((c) => c.closeTime < now);
  if (candles.length < 60) return null;

  const closes = candles.map((c) => c.close);
  const ef = ema(closes, 20);
  const es = ema(closes, 50);
  const rs = rsi(closes, 14);
  const at = atr(candles, 14);
  const i = candles.length - 1;
  const last = candles[i];
  const price = last.close;
  const a = at[i];
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(rs[i])) return null;

  const vols = candles.slice(-21, -1).map((c) => c.volume);
  const avgVol = vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length);
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 1;

  const gapPct = ((ef[i] - es[i]) / price) * 100;
  const prevGapPct = ((ef[i - 3] - es[i - 3]) / price) * 100;
  const atrPct = (a / price) * 100;

  let side: "long" | "short" | null = null;
  if (gapPct > 0 && price > ef[i] && rs[i] > 52 && rs[i] < 78) side = "long";
  else if (gapPct < 0 && price < ef[i] && rs[i] < 48 && rs[i] > 22) side = "short";
  if (!side) return null;

  // Confidence: trend strength (gap in ATR units), momentum, trend acceleration, volume.
  const dir = side === "long" ? 1 : -1;
  const trendScore = Math.min(1, Math.abs(gapPct) / Math.max(atrPct, 1e-9) / 1.5);
  const momScore = Math.min(1, Math.abs(rs[i] - 50) / 20);
  const accelScore = dir * (gapPct - prevGapPct) > 0 ? 1 : 0;
  const volScore = Math.min(1, Math.max(0, (volumeRatio - 0.6) / 1.2));
  const confidence = r(0.35 * trendScore + 0.3 * momScore + 0.15 * accelScore + 0.2 * volScore, 2);
  if (confidence < PROPOSE_FLOOR) return null;

  // Stop = 1.5×ATR, but never closer than MIN_STOP_PCT: on 5m majors 1.5×ATR is often ~0.1–0.2%,
  // which sits inside normal noise and would fail the Guardian's 0.2% floor anyway.
  const stopDist = Math.max(1.5 * a, price * MIN_STOP_PCT);
  const stopLoss = price - dir * stopDist;
  const takeProfit = price + dir * stopDist * 2;

  const id = bytesToHex(sha256(new TextEncoder().encode(`${symbol}|${side}|${interval}|${last.openTime}`))).slice(0, 16);

  return {
    id,
    symbol,
    side,
    interval,
    candleTime: last.openTime,
    entry: price,
    stopLoss: r(stopLoss, 8),
    takeProfit: r(takeProfit, 8),
    confidence,
    features: {
      emaFast: r(ef[i]),
      emaSlow: r(es[i]),
      rsi: r(rs[i], 2),
      atr: r(a),
      atrPct: r(atrPct, 4),
      trendGapPct: r(gapPct, 4),
      volumeRatio: r(volumeRatio, 2),
    },
    thesis: `${symbol} ${side}: EMA20 ${side === "long" ? "above" : "below"} EMA50 by ${Math.abs(gapPct).toFixed(2)}%, RSI ${rs[i].toFixed(1)}, volume ${volumeRatio.toFixed(1)}x avg; stop max(1.5×ATR, 0.35%), target 2R.`,
  };
}
