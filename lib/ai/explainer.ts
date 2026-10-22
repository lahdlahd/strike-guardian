/**
 * Claude explains a Guardian verdict in plain English. It is called AFTER the
 * verdict is fixed and has no way to change it. If Claude is unavailable
 * (no key, timeout, quota), a deterministic template is used instead, and the
 * artifact records which source produced the text.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { GuardianDecision } from "../guardian/engine.ts";
import type { TradeProposal } from "../strategy/proposer.ts";

export const EXPLAINER_MODEL = "claude-haiku-5-5";

export interface Explanation {
  text: string;
  source: string; // model id or "template"
}

let client: Anthropic | null = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ??= new Anthropic({ timeout: 10_000, maxRetries: 1 });
  return client;
}

const fmtPrice = (x: number) => (x >= 1000 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toPrecision(4));

export function templateExplanation(d: GuardianDecision, p: TradeProposal): string {
  const failed = d.checks.filter((c) => !c.passed);
  if (d.verdict === "APPROVE" && d.plan) {
    return `Approved ${p.side} ${d.plan.size} ${p.symbol} at ~${fmtPrice(p.entry)}: all ${d.total} checks passed, risking $${d.plan.riskUsd.toFixed(2)} with a stop at ${d.plan.stopPrice} and target at ${d.plan.takeProfitPrice}.`;
  }
  const head = d.verdict === "PAUSE" ? "Trading paused" : `Blocked ${p.side} ${p.symbol}`;
  return `${head}: ${failed.map((c) => `${c.name.toLowerCase()} (${c.value}; needs ${c.threshold})`).join("; ")}.`;
}

export async function explain(d: GuardianDecision, p: TradeProposal): Promise<Explanation> {
  const c = getClient();
  if (!c) return { text: templateExplanation(d, p), source: "template" };
  const facts = {
    verdict: d.verdict,
    proposal: { symbol: p.symbol, side: p.side, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, confidence: p.confidence, thesis: p.thesis },
    checks: d.checks.map(({ name, passed, value, threshold }) => ({ name, passed, value, threshold })),
    plan: d.plan,
  };
  try {
    const msg = await c.messages.create({
      model: EXPLAINER_MODEL,
      max_tokens: 220,
      system:
        "You explain a deterministic trading risk engine's verdict to a trader. The verdict is final and already executed or rejected; " +
        "never suggest overriding it, never invent numbers, use only the facts given. Two sentences, plain English, no markdown. " +
        "For BLOCK/PAUSE lead with the decisive failed check(s). For APPROVE state size, risk in dollars, stop and target.",
      messages: [{ role: "user", content: JSON.stringify(facts) }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    if (!text) throw new Error("empty");
    return { text, source: EXPLAINER_MODEL };
  } catch {
    return { text: templateExplanation(d, p), source: "template" };
  }
}
