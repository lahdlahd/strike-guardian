/**
 * Guardian v2 — deterministic pre-trade risk engine for Strike perps.
 *
 * Pure function: evaluate(context) → decision. No I/O, no clock reads, no LLM.
 * Every input it used is returned inside the decision, so anyone can replay it.
 * Claude only explains a verdict after the fact; it never sets one.
 */

import type { DepthResponse, Market, PositionResponse } from "../strike/types.ts";
import type { TradeProposal } from "../strategy/proposer.ts";
import { DEFAULT_POLICY, policyHash, type GuardianPolicy } from "./policy.ts";
import { floorSize, isolatedLiqPrice, minTradableSize, mmrFor, tickPrice, walkBook } from "./market-math.ts";

export type Verdict = "APPROVE" | "BLOCK" | "PAUSE";

export interface GuardianCheck {
  id: string;
  name: string;
  passed: boolean;
  critical: boolean;
  value: string;
  threshold: string;
  detail: string;
}

export interface RiskState {
  dayStartEquity: number;
  consecutiveLosses: number;
  lastLossAt: number | null; // ms
}

export interface GuardianContext {
  proposal: TradeProposal;
  market: Market | undefined;
  depth: DepthResponse;
  equity: number; // margin balance (wallet + uPnL)
  available: number;
  positions: PositionResponse[];
  risk: RiskState;
  now: number; // injected so the engine stays pure
  policy?: GuardianPolicy;
}

export interface OrderPlan {
  symbol: string;
  side: "buy" | "sell";
  size: string;
  leverage: number;
  stopPrice: string;
  takeProfitPrice: string;
  notionalUsd: number;
  marginUsd: number;
  riskUsd: number;
  sizedToExchangeMinimum: boolean;
}

export interface GuardianDecision {
  proposalId: string;
  symbol: string;
  side: "long" | "short";
  verdict: Verdict;
  passed: number;
  total: number;
  checks: GuardianCheck[];
  plan: OrderPlan | null; // only on APPROVE
  policyVersion: string;
  policyHash: string;
  evaluatedAt: number;
}

const pct = (x: number, d = 2) => `${x.toFixed(d)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;

export function evaluate(ctx: GuardianContext): GuardianDecision {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const p = ctx.proposal;
  const m = ctx.market;
  const checks: GuardianCheck[] = [];
  const add = (c: GuardianCheck) => checks.push(c);
  const dir = p.side === "long" ? 1 : -1;
  const orderSide: "buy" | "sell" = p.side === "long" ? "buy" : "sell";

  // 1 · Market live & whitelisted
  const listed = !!m && m.status === "trading" && !m.reduce_only;
  const white = policy.whitelist.includes(p.symbol);
  add({
    id: "market",
    name: "Market whitelisted & live",
    passed: listed && white,
    critical: true,
    value: !m ? "not listed" : `${m.status}${m.reduce_only ? " (reduce-only)" : ""}${white ? "" : ", not whitelisted"}`,
    threshold: policy.whitelist.join(", "),
    detail: !white ? `${p.symbol} is outside the whitelist.` : listed ? `${p.symbol} is trading.` : `${p.symbol} is not open for new positions.`,
  });

  // 2 · Confidence
  add({
    id: "confidence",
    name: "Signal confidence",
    passed: p.confidence >= policy.minConfidence,
    critical: true,
    value: p.confidence.toFixed(2),
    threshold: `≥ ${policy.minConfidence}`,
    detail: `Proposer scored this setup ${p.confidence.toFixed(2)}.`,
  });

  // 3 · Stop-loss sanity
  const stopDistPct = (Math.abs(p.entry - p.stopLoss) / p.entry) * 100;
  const stopOnRightSide = dir * (p.entry - p.stopLoss) > 0;
  const stopOk = stopOnRightSide && stopDistPct >= policy.minStopDistancePct && stopDistPct <= policy.maxStopDistancePct;
  add({
    id: "stop",
    name: "Stop-loss attached & sane",
    passed: stopOk,
    critical: true,
    value: stopOnRightSide ? pct(stopDistPct) : "wrong side",
    threshold: `${policy.minStopDistancePct}–${policy.maxStopDistancePct}%`,
    detail: stopOnRightSide ? `Stop ${pct(stopDistPct)} from entry.` : "Stop is on the wrong side of entry.",
  });

  // 4 · Reward:risk
  const rr = Math.abs(p.takeProfit - p.entry) / Math.max(Math.abs(p.entry - p.stopLoss), 1e-12);
  add({
    id: "rr",
    name: "Reward-to-risk",
    passed: rr >= policy.minRewardRisk,
    critical: true,
    value: `${rr.toFixed(2)}R`,
    threshold: `≥ ${policy.minRewardRisk}R`,
    detail: `Target ${rr.toFixed(2)}× the stop distance.`,
  });

  // Sizing (needs a market)
  let plan: OrderPlan | null = null;
  let sizeNum = 0;
  const openNotionalForSizing = ctx.positions.reduce((s, x) => s + Math.abs(Number(x.size)) * Number(x.entry_price), 0);
  if (m) {
    // Size to the TIGHTEST of: risk budget, account-leverage headroom, margin headroom.
    // Then the checks below verify the size we would actually send.
    const riskBudget = (ctx.equity * policy.maxRiskPerTradePct) / 100;
    const byRisk = riskBudget / Math.max(Math.abs(p.entry - p.stopLoss), 1e-12);
    const byLeverage = Math.max(0, policy.maxAccountLeverage * ctx.equity - openNotionalForSizing) / p.entry;
    const byMargin = ((ctx.available * policy.maxMarginUsePct) / 100) * policy.leverage / p.entry;
    const riskSized = Number(floorSize(Math.min(byRisk, byLeverage, byMargin), m));
    const minSize = Number(minTradableSize(m, p.entry));
    const bumped = riskSized < minSize;
    sizeNum = Math.max(riskSized, minSize);
    const size = bumped ? minTradableSize(m, p.entry) : floorSize(sizeNum, m);
    sizeNum = Number(size);
    const notional = sizeNum * p.entry;
    plan = {
      symbol: p.symbol,
      side: orderSide,
      size,
      leverage: policy.leverage,
      stopPrice: tickPrice(p.stopLoss, m, p.entry),
      takeProfitPrice: tickPrice(p.takeProfit, m, p.entry),
      notionalUsd: notional,
      marginUsd: notional / policy.leverage,
      riskUsd: sizeNum * Math.abs(p.entry - p.stopLoss),
      sizedToExchangeMinimum: bumped,
    };
  }

  // 5 · Risk per trade (on the size we would ACTUALLY send)
  const riskPct = plan ? (plan.riskUsd / Math.max(ctx.equity, 1e-9)) * 100 : Infinity;
  add({
    id: "risk",
    name: "Risk per trade",
    passed: riskPct <= policy.maxRiskPerTradePct,
    critical: true,
    value: plan ? `${usd(plan.riskUsd)} (${pct(riskPct)})` : "n/a",
    threshold: `≤ ${policy.maxRiskPerTradePct}% of equity`,
    detail: plan?.sizedToExchangeMinimum
      ? `Sized up to Strike's minimum order (${plan.size}); that minimum alone risks ${pct(riskPct)}.`
      : plan
        ? `Size ${plan.size} risks ${usd(plan.riskUsd)} if the stop is hit.`
        : "No market rules available.",
  });

  // 6 · Leverage (per-tier and account-level)
  const openNotional = ctx.positions.reduce((s, x) => s + Math.abs(Number(x.size)) * Number(x.entry_price), 0);
  const tier = m && plan ? mmrFor(m, plan.notionalUsd) : { mmr: 0.01, maxLeverage: 0 };
  const acctLev = plan ? (openNotional + plan.notionalUsd) / Math.max(ctx.equity, 1e-9) : Infinity;
  add({
    id: "leverage",
    name: "Leverage limits",
    passed: !!plan && policy.leverage <= tier.maxLeverage && acctLev <= policy.maxAccountLeverage,
    critical: true,
    value: `${policy.leverage}x position, ${acctLev.toFixed(2)}x account`,
    threshold: `≤ ${policy.maxAccountLeverage}x account, ≤ tier max ${tier.maxLeverage}x`,
    detail: `Open notional ${usd(openNotional)} + this trade ${usd(plan?.notionalUsd ?? 0)} on ${usd(ctx.equity)} equity.`,
  });

  // 7 · Margin available
  const marginUse = plan ? (plan.marginUsd / Math.max(ctx.available, 1e-9)) * 100 : Infinity;
  add({
    id: "margin",
    name: "Margin available",
    passed: marginUse <= policy.maxMarginUsePct,
    critical: true,
    value: plan ? `${usd(plan.marginUsd)} of ${usd(ctx.available)} (${pct(marginUse, 0)})` : "n/a",
    threshold: `≤ ${policy.maxMarginUsePct}% of available`,
    detail: "Isolated margin this trade would lock.",
  });

  // 8 · Liquidation buffer — the stop must fire long before liquidation
  const liq = isolatedLiqPrice(p.entry, p.side, policy.leverage, tier.mmr);
  const liqDistPct = (Math.abs(p.entry - liq) / p.entry) * 100;
  const liqMultiple = liqDistPct / Math.max(stopDistPct, 1e-9);
  add({
    id: "liquidation",
    name: "Liquidation buffer",
    passed: liqMultiple >= policy.minLiqBufferMultiple,
    critical: true,
    value: `liq ≈ ${liq.toFixed(4)} (${pct(liqDistPct)} away, ${liqMultiple.toFixed(1)}× stop)`,
    threshold: `≥ ${policy.minLiqBufferMultiple}× stop distance`,
    detail: `Isolated ${policy.leverage}x, MMR ${(tier.mmr * 100).toFixed(2)}%.`,
  });

  // 9 · Funding drag
  const fundingHourly = Number(m?.funding_rate ?? 0);
  const fundingCostPct = dir * fundingHourly * policy.fundingHoldHours * 100; // + = we pay
  const rewardPct = (Math.abs(p.takeProfit - p.entry) / p.entry) * 100;
  const fundingShare = rewardPct > 0 ? (Math.max(fundingCostPct, 0) / rewardPct) * 100 : 0;
  add({
    id: "funding",
    name: "Funding drag",
    passed: fundingShare <= policy.maxFundingCostOfRewardPct,
    critical: true,
    value: `${fundingCostPct >= 0 ? "pay" : "earn"} ${pct(Math.abs(fundingCostPct), 4)} over ${policy.fundingHoldHours}h`,
    threshold: `≤ ${policy.maxFundingCostOfRewardPct}% of target`,
    detail: `Hourly funding ${pct(fundingHourly * 100, 4)}; ${p.side} ${fundingCostPct >= 0 ? "pays" : "receives"}.`,
  });

  // 10 · Spread & slippage (walk the live book for our size)
  const bw = walkBook(ctx.depth, orderSide, sizeNum || 0);
  add({
    id: "slippage",
    name: "Spread & slippage",
    passed: bw.filled && bw.spreadPct <= policy.maxSpreadPct && bw.slippagePct <= policy.maxSlippagePct,
    critical: true,
    value: `spread ${pct(bw.spreadPct, 3)}, fill ${Number.isFinite(bw.slippagePct) ? pct(bw.slippagePct, 3) : "book too thin"}`,
    threshold: `spread ≤ ${policy.maxSpreadPct}%, slippage ≤ ${policy.maxSlippagePct}%`,
    detail: `Walked ${ctx.depth.bids.length + ctx.depth.asks.length} book levels for ${plan?.size ?? 0}.`,
  });

  // 11 · Exposure / correlation
  const open = ctx.positions.filter((x) => Number(x.size) !== 0);
  const sameSymbol = open.some((x) => x.symbol === p.symbol);
  const sameDir = open.filter((x) => Math.sign(Number(x.size)) === dir).length;
  add({
    id: "exposure",
    name: "Exposure & correlation",
    passed: !sameSymbol && open.length < policy.maxOpenPositions && sameDir < policy.maxPerDirection,
    critical: true,
    value: `${open.length} open, ${sameDir} ${p.side}${sameSymbol ? `, already in ${p.symbol}` : ""}`,
    threshold: `< ${policy.maxOpenPositions} open, < ${policy.maxPerDirection} per direction`,
    detail: "BTC/ETH/SOL move together; one bet per direction.",
  });

  // 12 · Daily loss limit
  const dd = ctx.risk.dayStartEquity > 0 ? ((ctx.risk.dayStartEquity - ctx.equity) / ctx.risk.dayStartEquity) * 100 : 0;
  add({
    id: "daily_loss",
    name: "Daily loss limit",
    passed: dd < policy.maxDailyLossPct,
    critical: true,
    value: pct(Math.max(dd, 0)),
    threshold: `< ${policy.maxDailyLossPct}%`,
    detail: `Day opened at ${usd(ctx.risk.dayStartEquity)}, now ${usd(ctx.equity)}.`,
  });

  // 13 · Cooldown after consecutive losses
  const inCooldown =
    ctx.risk.consecutiveLosses >= policy.cooldownLosses &&
    ctx.risk.lastLossAt !== null &&
    ctx.now - ctx.risk.lastLossAt < policy.cooldownMinutes * 60_000;
  add({
    id: "cooldown",
    name: "Loss-streak cooldown",
    passed: !inCooldown,
    critical: true,
    value: `${ctx.risk.consecutiveLosses} consecutive loss(es)`,
    threshold: `pause ${policy.cooldownMinutes}m after ${policy.cooldownLosses}`,
    detail: inCooldown ? "Cooling off: no revenge trades." : "No active cooldown.",
  });

  const failedCritical = checks.some((c) => c.critical && !c.passed);
  const verdict: Verdict = inCooldown || checks.find((c) => c.id === "daily_loss")?.passed === false ? "PAUSE" : failedCritical ? "BLOCK" : "APPROVE";

  return {
    proposalId: p.id,
    symbol: p.symbol,
    side: p.side,
    verdict,
    passed: checks.filter((c) => c.passed).length,
    total: checks.length,
    checks,
    plan: verdict === "APPROVE" ? plan : null,
    policyVersion: policy.version,
    policyHash: policyHash(policy),
    evaluatedAt: ctx.now,
  };
}
