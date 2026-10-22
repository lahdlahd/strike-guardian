/**
 * Strike Guardian — autonomous agent loop.
 *
 *   npm run agent            # DRY RUN: proposes + evaluates + signs, never places orders
 *   LIVE_TRADING=true npm run agent
 *
 * Each cycle:
 *   control flags → clock/market refresh → reconcile positions (outcomes) →
 *   for each watched symbol: closed candles → proposal → Guardian → signed decision artifact →
 *   (live + APPROVE) bracket order on Strike → signed execution artifact.
 *   Separately, an LLM writes a plain-English explanation as its own signed artifact — never on the trading path.
 */

import "dotenv/config";
import { StrikeClient, describeNetworkError } from "../lib/strike/client.ts";
import { loadKeysFromEnv, publicKeyFromPrivate } from "../lib/strike/auth.ts";
import { StrikeApiError, type Market, type PositionResponse } from "../lib/strike/types.ts";
import { propose, type TradeProposal } from "../lib/strategy/proposer.ts";
import { evaluate, type RiskState } from "../lib/guardian/engine.ts";
import { DEFAULT_POLICY, policyHash } from "../lib/guardian/policy.ts";
import { explain, explainerSource, templateExplanation } from "../lib/ai/explainer.ts";
import { openStore } from "../lib/artifacts/store.ts";
import { Ledger } from "../lib/artifacts/ledger.ts";

const LIVE = process.env.LIVE_TRADING === "true";
const INTERVAL = process.env.CANDLE_INTERVAL ?? "5m";
const CYCLE_MS = Number(process.env.CYCLE_SECONDS ?? 60) * 1000;
const WATCH = (process.env.WATCHLIST ?? "BTC-USD,ETH-USD,SOL-USD,HYPE-USD,NIGHT-USD").split(",").map((s) => s.trim()).filter(Boolean);
const policy = DEFAULT_POLICY;

interface TrackedTrade {
  proposalId: string;
  symbol: string;
  side: "long" | "short";
  equityAtOpen: number;
  walletAtOpen?: number; // realized-only baseline (wallet balance excludes unrealized PnL of other positions)
  placedAt: number;
  seenOpen: boolean;
  cyclesUnseen: number;
}
interface Control {
  paused?: boolean;
  kill?: boolean;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errMsg = (e: unknown) => (e instanceof StrikeApiError ? `${e.status} ${e.body.slice(0, 200)}` : describeNetworkError(e));
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

async function main() {
  const keys = loadKeysFromEnv();
  if (!keys) throw new Error("STRIKE_API_PRIVATE_KEY missing (npm run keygen)");
  const attestPriv = process.env.GUARDIAN_ATTEST_PRIVATE_KEY?.trim();
  if (!attestPriv) throw new Error("GUARDIAN_ATTEST_PRIVATE_KEY missing (npm run keygen:attest)");
  if (attestPriv === keys.privateKey) throw new Error("Attestation key must differ from the trading key");

  const strike = new StrikeClient({ keys, builderFeeBps: Number(process.env.STRIKE_BUILDER_FEE_BPS ?? 0), subAccountId: process.env.STRIKE_SUB_ACCOUNT_ID });
  const store = openStore();
  const ledger = new Ledger(store, attestPriv, publicKeyFromPrivate(attestPriv), strike.cfg.network);
  await ledger.init();

  const drift = await strike.syncClock();
  let markets = await strike.markets();
  const acct = await strike.account();

  // Configure whitelisted markets: isolated margin, fixed leverage (best effort — fails if a position is open).
  const setup: Record<string, string> = {};
  if (LIVE) {
    for (const s of policy.whitelist) {
      try {
        await strike.setMarginMode(s, "isolated");
        await strike.setLeverage(s, policy.leverage);
        setup[s] = `isolated ${policy.leverage}x`;
      } catch (e) {
        setup[s] = `unchanged (${errMsg(e)})`;
      }
    }
  }

  await ledger.write("boot", {
    live: LIVE,
    interval: INTERVAL,
    cycleSeconds: CYCLE_MS / 1000,
    watchlist: WATCH,
    policy,
    policyHash: policyHash(policy),
    tradingPubKey: keys.publicKey,
    accountId: acct.account_id,
    equity: Number(acct.wallet_balance) + Number(acct.unrealized_pnl || 0),
    clockDriftSec: Number(drift.toFixed(2)),
    builderFeeBps: Number(process.env.STRIKE_BUILDER_FEE_BPS ?? 0),
    explainer: explainerSource(),
    marketSetup: setup,
  });
  log(`boot · ${strike.cfg.network} · ${LIVE ? "LIVE" : "DRY RUN"} · ${WATCH.join(",")} · ${INTERVAL} · equity $${Number(acct.wallet_balance).toFixed(2)} · explainer ${explainerSource()}`);

  const seen = new Set<string>((await store.getState<string[]>("seen_proposals")) ?? []);
  let tracked: TrackedTrade[] = (await store.getState<TrackedTrade[]>("tracked_trades")) ?? [];
  let cycle = 0;
  let stopping = false;
  const pendingExplains = new Set<Promise<unknown>>();
  let wake: (() => void) | null = null;
  const stop = (sig: string) => {
    if (stopping) {
      log(`${sig} again: forcing exit`);
      process.exit(130);
    }
    stopping = true;
    log(`${sig}: finishing current step and stopping (press Ctrl+C again to force)`);
    wake?.(); // cut the between-cycle sleep short
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  while (!stopping) {
    const started = Date.now();
    cycle++;
    try {
      const control = (await store.getState<Control>("control")) ?? {};

      if (cycle % 10 === 0) await strike.syncClock();
      markets = await strike.markets(); // public; refreshes mark, funding, best bid/ask

      const account = await strike.account();
      // margin_balance is the CROSS balance (excludes isolated margin), so equity = wallet + uPnL.
      const equity = Number(account.wallet_balance) + Number(account.unrealized_pnl || 0);
      const available = Number(account.available_balance);
      const positions = (await strike.positions()).filter((p) => Number(p.size) !== 0);

      // Kill switch (set from the dashboard or `npm run kill`)
      if (control.kill) {
        const r = await strike.killSwitch();
        await ledger.write("kill", { reason: "operator kill switch", result: r as unknown as Record<string, unknown>, positionsClosed: positions.map((p) => p.symbol) });
        await store.setState("control", { paused: true, kill: false });
        tracked = [];
        await store.setState("tracked_trades", tracked);
        log("KILL SWITCH executed — orders cancelled, positions flattened, agent paused");
        continue;
      }

      // Risk state (UTC day rollover)
      let risk = (await store.getState<RiskState & { day: string }>("risk")) ?? { day: utcDay(started), dayStartEquity: equity, consecutiveLosses: 0, lastLossAt: null };
      if (risk.day !== utcDay(started)) risk = { ...risk, day: utcDay(started), dayStartEquity: equity };

      // Reconcile: detect closed / never-filled trades → outcome artifacts
      const openSymbols = new Set(positions.map((p) => p.symbol));
      const still: TrackedTrade[] = [];
      for (const t of tracked) {
        if (openSymbols.has(t.symbol)) {
          still.push({ ...t, seenOpen: true, cyclesUnseen: 0 });
          continue;
        }
        if (!t.seenOpen && t.cyclesUnseen < 3) {
          still.push({ ...t, cyclesUnseen: t.cyclesUnseen + 1 });
          continue;
        }
        try {
          await strike.cancelAll(t.symbol); // clear any orphaned TP/SL leg
        } catch {
          /* nothing to cancel */
        }
        const wallet = Number(account.wallet_balance);
        // Wallet balance moves only on realized PnL, fees and funding, so other open positions can't leak in.
        const pnl = t.walletAtOpen !== undefined ? wallet - t.walletAtOpen : equity - t.equityAtOpen;
        const result = !t.seenOpen ? "not_filled" : pnl < 0 ? "loss" : "win";
        if (result === "loss") risk = { ...risk, consecutiveLosses: risk.consecutiveLosses + 1, lastLossAt: started };
        if (result === "win") risk = { ...risk, consecutiveLosses: 0 };
        await ledger.write(
          "outcome",
          { proposalId: t.proposalId, side: t.side, result, pnlUsdApprox: Number(pnl.toFixed(4)), equityAtOpen: t.equityAtOpen, equityNow: equity, heldMinutes: Math.round((started - t.placedAt) / 60000), note: t.walletAtOpen !== undefined ? "Realized PnL from wallet-balance change; includes fees & funding. Strike's trade history is authoritative." : "Approximated from equity change (legacy). Strike's trade history is authoritative." },
          { symbol: t.symbol, verdict: result.toUpperCase() }
        );
        log(`outcome ${t.symbol} ${result} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}`);
      }
      tracked = still;
      await store.setState("risk", risk);

      // Evaluate each watched symbol
      let proposalsThisCycle = 0;
      for (const symbol of WATCH) {
        if (control.paused || stopping) break;
        const market: Market | undefined = markets[symbol];
        try {
          const candles = await strike.klines(symbol, INTERVAL, 200);
          const raw = propose(symbol, INTERVAL, candles);
          if (!raw || seen.has(raw.id)) continue;
          seen.add(raw.id);
          proposalsThisCycle++;

          // Re-anchor entry to the live mark: if price already ran through the stop, the Guardian will see it.
          const live = Number(market?.mark_price) || raw.entry;
          const proposal: TradeProposal = { ...raw, entry: live };
          const depth = await strike.depth(symbol, 50);
          // Record the COMPLETE Guardian input so anyone can replay the verdict (npm run verify).
          const inputs = { proposal, market, depth, equity, available, positions, risk: { dayStartEquity: risk.dayStartEquity, consecutiveLosses: risk.consecutiveLosses, lastLossAt: risk.lastLossAt }, now: Date.now(), policy };
          const decision = evaluate(inputs);
          // Sign the decision NOW with the deterministic template; the LLM explains later, off the trading path.
          const explanation = { text: templateExplanation(decision, proposal), source: "template" };
          const decisionArtifact = await ledger.write("decision", { inputs, decision, explanation, live: LIVE }, { symbol, verdict: decision.verdict });
          log(`${decision.verdict.padEnd(7)} ${symbol} ${proposal.side} conf ${proposal.confidence} · ${decision.passed}/${decision.total}`);
          if (explainerSource() !== "template") {
            const job: Promise<unknown> = explain(decision, proposal).then(async (e) => {
              if (e.source === "template") {
                log(`        explainer unavailable for #${decisionArtifact.seq}: ${e.fallbackReason ?? "no text"}`);
                return;
              }
              await ledger.write("explanation", { decisionSeq: decisionArtifact.seq, decisionHash: decisionArtifact.hash, proposalId: proposal.id, text: e.text, source: e.source }, { symbol });
              log(`        explained #${decisionArtifact.seq} via ${e.source}`);
            }).catch((err) => log(`        explanation write failed: ${errMsg(err)}`));
            pendingExplains.add(job);
            void job.finally(() => pendingExplains.delete(job));
          }

          if (decision.verdict !== "APPROVE" || !decision.plan) continue;
          if (!LIVE) continue;

          const plan = decision.plan;
          const strategyId = `sg-${proposal.id}`;
          try {
            const r = await strike.placeBracket({
              strategy_id: strategyId,
              client_order_id: `${strategyId}-entry`,
              symbol,
              side: plan.side,
              type: "market",
              size: plan.size,
              slippage: String(policy.maxSlippagePct / 100 * 2),
              tp_order: { client_order_id: `${strategyId}-tp`, type: "take_profit", size: plan.size, stop_price: plan.takeProfitPrice, working_type: "mark_price" },
              sl_order: { client_order_id: `${strategyId}-sl`, type: "stop", size: plan.size, stop_price: plan.stopPrice, working_type: "mark_price" },
            });
            // The order is live on Strike now: remember it FIRST, so a database blip can't make us forget it.
            tracked.push({ proposalId: proposal.id, symbol, side: proposal.side, equityAtOpen: equity, walletAtOpen: Number(account.wallet_balance), placedAt: Date.now(), seenOpen: false, cyclesUnseen: 0 });
            positions.push({ symbol, size: plan.side === "buy" ? plan.size : `-${plan.size}`, entry_price: String(live) } as PositionResponse); // exposure for the rest of this cycle
            log(`SENT    ${symbol} bracket ${plan.side} ${plan.size} · seq ${r.sequence_id}`);
            const execBody = { proposalId: proposal.id, plan, request: { endpoint: "POST /v2/order/strategy", strategyId }, response: r as unknown as Record<string, unknown> };
            const execMeta = { symbol, verdict: "SENT", strike: { sequence_id: r.sequence_id, message_id: r.message_id, client_order_id: r.primary_client_order_id, strategy_id: r.strategy_id } };
            await store.setState("tracked_trades", tracked).catch(() => undefined);
            await ledger.write("execution", execBody, execMeta).catch(async (e) => {
              log(`        execution sent but ledger write failed (${errMsg(e)}); retrying in 5s`);
              await new Promise((res) => setTimeout(res, 5_000));
              await ledger.write("execution", execBody, execMeta).catch((e2) => log(`        ledger still unavailable: ${errMsg(e2)}`));
            });
          } catch (e) {
            // placeBracket itself failed (Strike rejected it or it never arrived): nothing was opened.
            log(`FAILED  ${symbol} ${errMsg(e)}`);
            await ledger.write("error", { stage: "execution", proposalId: proposal.id, plan, error: errMsg(e) }, { symbol, verdict: "FAILED" }).catch(() => undefined);
          }
        } catch (e) {
          log(`warn ${symbol}: ${errMsg(e)}`);
        }
      }

      await store.setState("tracked_trades", tracked);
      await store.setState("seen_proposals", [...seen].slice(-500));
      log(`cycle ${cycle} · equity $${equity.toFixed(2)} · ${positions.length} open · ${proposalsThisCycle} new proposal(s)${control.paused ? " · PAUSED" : ""}`);
      await store.setState("heartbeat", {
        at: Date.now(),
        cycle,
        live: LIVE,
        network: strike.cfg.network,
        paused: !!control.paused,
        equity,
        available,
        positions: positions.map((p) => ({ symbol: p.symbol, size: p.size, entry: p.entry_price, upnl: p.upnl, liq: p.liquidation_price, leverage: p.leverage })),
        markets: Object.fromEntries(WATCH.map((s) => [s, { mark: markets[s]?.mark_price, funding: markets[s]?.funding_rate, bid: markets[s]?.bid1_price, ask: markets[s]?.ask1_price }])),
        attestPubKey: ledger.attestPubKey,
      });
    } catch (e) {
      log(`cycle ${cycle} error: ${errMsg(e)}`);
    }
    if (stopping) break;
    const wait = Math.max(1000, CYCLE_MS - (Date.now() - started));
    await new Promise<void>((r) => {
      const t = setTimeout(r, wait);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
    wake = null;
  }
  if (pendingExplains.size) {
    log(`waiting up to 5s for ${pendingExplains.size} explanation(s)…`);
    await Promise.race([Promise.allSettled([...pendingExplains]), new Promise((r) => setTimeout(r, 5_000))]);
  }
  await ledger.drain();
  await store.close();
  log("stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
