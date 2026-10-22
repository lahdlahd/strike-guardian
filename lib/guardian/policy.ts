import { createHash } from "node:crypto";
import { canonicalJson } from "../util/canonical.ts";

export interface GuardianPolicy {
  version: string;
  whitelist: string[];
  minConfidence: number;
  maxRiskPerTradePct: number; // % of equity lost if the stop is hit
  minStopDistancePct: number;
  maxStopDistancePct: number;
  minRewardRisk: number;
  leverage: number; // per-position leverage the agent sets (isolated)
  maxAccountLeverage: number; // total open notional / equity
  maxMarginUsePct: number; // of available balance per trade
  minLiqBufferMultiple: number; // liquidation distance must be ≥ N × stop distance
  maxSpreadPct: number;
  maxSlippagePct: number; // vs mid, walking the book for our size
  fundingHoldHours: number;
  maxFundingCostOfRewardPct: number; // funding cost over hold ≤ this % of reward
  maxOpenPositions: number;
  maxPerDirection: number; // crypto majors are highly correlated
  maxDailyLossPct: number;
  cooldownLosses: number;
  cooldownMinutes: number;
}

export const DEFAULT_POLICY: GuardianPolicy = {
  version: "strike-guardian/1.0",
  whitelist: ["BTC-USD", "ETH-USD", "SOL-USD"],
  minConfidence: 0.6,
  maxRiskPerTradePct: 1.0,
  minStopDistancePct: 0.2,
  maxStopDistancePct: 3.0,
  minRewardRisk: 1.5,
  leverage: 3,
  maxAccountLeverage: 3,
  maxMarginUsePct: 60,
  minLiqBufferMultiple: 2,
  maxSpreadPct: 0.1,
  maxSlippagePct: 0.15,
  fundingHoldHours: 4,
  maxFundingCostOfRewardPct: 20,
  maxOpenPositions: 2,
  maxPerDirection: 1,
  maxDailyLossPct: 5,
  cooldownLosses: 2,
  cooldownMinutes: 120,
};

export function policyHash(p: GuardianPolicy): string {
  return createHash("sha256").update(canonicalJson(p)).digest("hex");
}
