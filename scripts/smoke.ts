/**
 * Phase 0 smoke test — the 12:00 go/no-go gate.
 *
 *   npm run smoke                     # testnet (default)
 *   STRIKE_NETWORK=mainnet npm run smoke
 *
 * Read-only: it never places, cancels or modifies anything.
 * Writes smoke-report.json (no secrets in it) — paste the console output back to Claude.
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { StrikeClient } from "../lib/strike/client.ts";
import { loadKeysFromEnv } from "../lib/strike/auth.ts";
import { PriceStream } from "../lib/strike/price-stream.ts";
import type { Market } from "../lib/strike/types.ts";

type Row = { step: string; ok: boolean; detail: string };
const rows: Row[] = [];
const report: Record<string, unknown> = { at: new Date().toISOString() };
const record = (step: string, ok: boolean, detail: string) => {
  rows.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step.padEnd(28)} ${detail}`);
};

async function main() {
  let keys = null;
  try {
    keys = loadKeysFromEnv();
  } catch (e) {
    record("keys", false, (e as Error).message);
  }
  const client = new StrikeClient({ keys, subAccountId: process.env.STRIKE_SUB_ACCOUNT_ID });
  report.network = client.cfg.network;
  console.log(`\nStrike Guardian · Phase 0 smoke test · ${client.cfg.network} (${client.cfg.apiBase})\n`);

  // 1. Clock
  try {
    const drift = await client.syncClock();
    report.clockDriftSec = Number(drift.toFixed(2));
    record("clock sync (/v2/time)", Math.abs(drift) < 170, `local clock is ${drift.toFixed(2)}s ${drift >= 0 ? "behind" : "ahead of"} Strike (offset applied)`);
  } catch (e) {
    record("clock sync (/v2/time)", false, (e as Error).message);
  }

  // 2. Markets + sizing feasibility
  let markets: Record<string, Market> = {};
  try {
    markets = await client.markets();
    const trading = Object.values(markets).filter((m) => m.status === "trading");
    record("markets (/v2/markets)", trading.length > 0, `${Object.keys(markets).length} listed, ${trading.length} trading`);

    const budgets = [10, 15];
    const leverageCap = 3;
    const table = trading.map((m) => {
      const mark = Number(m.mark_price) || Number(m.last_price);
      const minSize = Number(m.order_market_min_size);
      const minNotional = Math.max(minSize * mark, Number(m.order_min_notional) || 0);
      const tier1Max = m.margin_tiers?.[0]?.max_leverage ?? m.default_leverage;
      const marginAtCap = minNotional / Math.min(leverageCap, tier1Max);
      const spreadPct = Number(m.ask1_price) && Number(m.bid1_price) ? ((Number(m.ask1_price) - Number(m.bid1_price)) / mark) * 100 : NaN;
      return {
        symbol: m.symbol,
        mark: Number(mark.toFixed(m.quote_prec ?? 2)),
        minSize,
        minTradeUsd: Number(minNotional.toFixed(2)),
        tier1MaxLev: tier1Max,
        marginAt3xUsd: Number(marginAtCap.toFixed(2)),
        fits10: marginAtCap <= budgets[0] * 0.5,
        fits15: marginAtCap <= budgets[1] * 0.5,
        fundingHourlyPct: Number((Number(m.funding_rate) * 100).toFixed(4)),
        spreadPct: Number.isFinite(spreadPct) ? Number(spreadPct.toFixed(3)) : null,
      };
    });
    report.markets = table;
    console.log("\n  Smallest allowed trade per market (fitsN = min trade at 3x uses ≤50% of an $N account):");
    console.table(table);
  } catch (e) {
    record("markets (/v2/markets)", false, (e as Error).message);
  }

  const probe = markets["BTC-USD"] ? "BTC-USD" : Object.keys(markets)[0];

  // 3. Price service REST
  if (probe) {
    try {
      const k = await client.klines(probe, "15m", 100);
      record("klines (/price/v2/klines)", k.length > 0, `${k.length} × 15m candles for ${probe}, last close ${k.at(-1)?.close}`);
    } catch (e) {
      record("klines (/price/v2/klines)", false, (e as Error).message);
    }
    try {
      const d = await client.depth(probe, 20);
      record("order book (/price/v2/depth)", d.bids.length > 0 && d.asks.length > 0, `${d.bids.length} bids / ${d.asks.length} asks, best ${d.bids[0]?.[0]} / ${d.asks[0]?.[0]}`);
    } catch (e) {
      record("order book (/price/v2/depth)", false, (e as Error).message);
    }
  }

  // 4. WebSocket
  if (probe) {
    const got = await new Promise<string>((resolve) => {
      let done = false;
      const s = new PriceStream(client.cfg.priceWs, (ev) => {
        if (!done && (ev.e === "markPriceUpdate" || ev.p || ev.markPrice)) {
          done = true;
          s.close();
          resolve(`markPrice event received (${JSON.stringify(ev).slice(0, 90)}…)`);
        }
      });
      s.connect();
      s.subscribe("markPrice@1s", probe);
      setTimeout(() => {
        if (!done) {
          done = true;
          s.close();
          resolve("");
        }
      }, 12_000);
    });
    record("price WebSocket", !!got, got || `no markPrice event within 12s on ${client.cfg.priceWs} (REST polling fallback will be used)`);
  }

  // 5. Authenticated calls
  if (!keys) {
    record("API wallet", false, "no STRIKE_API_PRIVATE_KEY in .env — run `npm run keygen`, register the public key, re-run");
  } else {
    report.publicKey = keys.publicKey;
    try {
      const a = await client.account();
      report.account = { id: a.account_id, wallet: a.wallet_balance, available: a.available_balance, subAccounts: a.sub_accounts?.length ?? 0, marginMode: a.default_margin_mode };
      record("signed GET /v2/account", true, `account ${a.account_id.slice(0, 8)}… wallet $${a.wallet_balance}, available $${a.available_balance}`);
      if (Number(a.wallet_balance) <= 0) record("funding", false, "balance is $0 — fund this account (testnet faucet or $10–15 USDC on mainnet)");
      else record("funding", true, `$${a.wallet_balance} available to trade`);
    } catch (e) {
      record("signed GET /v2/account", false, (e as Error).message);
    }
    try {
      const p = await client.positions();
      record("signed GET /v2/positions", true, `${p.length} open position(s)`);
    } catch (e) {
      record("signed GET /v2/positions", false, (e as Error).message);
    }
  }

  // Verdict
  const must = ["clock sync (/v2/time)", "markets (/v2/markets)", "klines (/price/v2/klines)", "signed GET /v2/account", "funding"];
  const fails = rows.filter((r) => !r.ok && must.includes(r.step)).map((r) => r.step);
  const verdict = fails.length === 0 ? "GO" : "NO-GO";
  report.rows = rows;
  report.verdict = verdict;
  writeFileSync("smoke-report.json", JSON.stringify(report, null, 2));
  console.log(`\n${verdict}${fails.length ? ` — blocking: ${fails.join(", ")}` : ""}\nReport saved to smoke-report.json (contains no private keys).\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
