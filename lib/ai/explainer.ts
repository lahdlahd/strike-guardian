/**
 * An LLM explains a Guardian verdict in plain English. It runs OFF the trading path:
 * the decision is signed (with a deterministic template explanation) and any order is
 * sent first; the LLM text arrives later as its own signed "explanation" artifact that
 * references the decision. A slow or failing model can never delay or change a trade.
 *
 * Provider, in order:
 *   ANTHROPIC_API_KEY                  → Claude (claude-haiku-5-5, override with ANTHROPIC_MODEL)
 *   OPENAI_API_KEY + OPENAI_MODEL      → OpenAI Responses API (model id set explicitly; no guessing)
 *   neither / any failure (quota, timeout, empty) → deterministic template
 * The artifact records which source produced the text.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { GuardianDecision } from "../guardian/engine.ts";
import type { TradeProposal } from "../strategy/proposer.ts";

export const EXPLAINER_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-5-5";

export interface Explanation {
  text: string;
  source: string; // model id or "template"
  fallbackReason?: string; // why the template was used, when an LLM was configured
}

const SYSTEM =
  "You explain a deterministic trading risk engine's verdict to a trader. The verdict is final and already executed or rejected; " +
  "never suggest overriding it, never invent numbers, use only the facts given. Two sentences, plain English, no markdown. " +
  "For BLOCK/PAUSE lead with the decisive failed check(s). For APPROVE state size, risk in dollars, stop and target.";

let anthropic: Anthropic | null = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  anthropic ??= new Anthropic({ timeout: Number(process.env.EXPLAINER_TIMEOUT_MS ?? 60_000), maxRetries: 1 });
  return anthropic;
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

function facts(d: GuardianDecision, p: TradeProposal) {
  return JSON.stringify({
    verdict: d.verdict,
    proposal: { symbol: p.symbol, side: p.side, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, confidence: p.confidence, thesis: p.thesis },
    checks: d.checks.map(({ name, passed, value, threshold }) => ({ name, passed, value, threshold })),
    plan: d.plan,
  });
}

async function viaClaude(c: Anthropic, d: GuardianDecision, p: TradeProposal): Promise<string> {
  const msg = await c.messages.create({
    model: EXPLAINER_MODEL,
    max_tokens: 220,
    system: SYSTEM,
    messages: [{ role: "user", content: facts(d, p) }],
  });
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

/** Raw HTTP to the OpenAI Responses API — no SDK, so no SDK-version surprises. */
async function viaOpenAI(key: string, model: string, d: GuardianDecision, p: TradeProposal): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.EXPLAINER_TIMEOUT_MS ?? 60_000));
  // OPENAI_BASE_URL: an OpenAI-compatible base such as https://api.openai.com/v1 or a router's /v1.
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = base.endsWith("/responses") ? base : `${base}/responses`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      // Generous output cap: reasoning models spend part of it thinking before they write.
      body: JSON.stringify({ model, instructions: SYSTEM, input: facts(d, p), max_output_tokens: 800 }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.slice(0, 160)}`);
    const j = JSON.parse(body) as { output_text?: string; output?: { type: string; content?: { type: string; text?: string }[] }[] };
    if (typeof j.output_text === "string" && j.output_text.trim()) return j.output_text.trim();
    return (j.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text" && c.text)
      .map((c) => c.text)
      .join("")
      .trim();
  } finally {
    clearTimeout(t);
  }
}

/** Which provider is configured (for the boot artifact and logs). */
export function explainerSource(): string {
  if (process.env.ANTHROPIC_API_KEY) return EXPLAINER_MODEL;
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) return process.env.OPENAI_MODEL.trim();
  return "template";
}

export async function explain(d: GuardianDecision, p: TradeProposal): Promise<Explanation> {
  const template = () => templateExplanation(d, p);
  try {
    const c = getAnthropic();
    if (c) {
      const text = await viaClaude(c, d, p);
      if (!text) throw new Error("empty response");
      return { text, source: EXPLAINER_MODEL };
    }
    const key = process.env.OPENAI_API_KEY?.trim();
    const model = process.env.OPENAI_MODEL?.trim();
    if (key && model) {
      const text = await viaOpenAI(key, model, d, p);
      if (!text) throw new Error("empty response");
      return { text, source: model };
    }
    return { text: template(), source: "template" };
  } catch (e) {
    return { text: template(), source: "template", fallbackReason: (e as Error).message?.slice(0, 200) };
  }
}
