"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { verifyArtifact, type Artifact } from "../lib/artifacts/artifact.ts";
import { evaluate, type GuardianCheck, type GuardianContext, type GuardianDecision } from "../lib/guardian/engine.ts";

type DecisionBody = { inputs?: GuardianContext; decision: GuardianDecision; explanation: { text: string; source: string }; live: boolean };
type Heartbeat = {
  at: number; cycle: number; live: boolean; network: string; paused: boolean; equity: number; available: number;
  positions: { symbol: string; size: string; entry: string; upnl: string; liq: string; leverage: number }[];
  markets: Record<string, { mark?: string; funding?: string; bid?: string; ask?: string }>;
  attestPubKey: string;
};
type State = {
  heartbeat: Heartbeat | null;
  control: { paused?: boolean; kill?: boolean };
  risk: { dayStartEquity: number; consecutiveLosses: number } | null;
  stats: { decisions: number; verdicts: Record<string, number>; failedBy: { id: string; name: string; count: number }[]; executions: number; outcomes: { total: number; wins: number; losses: number } };
  serverTime: number;
};

const SHORT: Record<string, string> = {
  market: "Market", confidence: "Confidence", stop: "Stop-loss", rr: "Reward:risk", risk: "Risk", leverage: "Leverage",
  margin: "Margin", liquidation: "Liq. buffer", funding: "Funding", slippage: "Slippage", exposure: "Exposure",
  daily_loss: "Daily loss", cooldown: "Cooldown",
};
const WORD: Record<string, string> = {
  APPROVE: "Approved", BLOCK: "Blocked", PAUSE: "Paused", SENT: "Sent", WIN: "Profit", LOSS: "Loss",
  NOT_FILLED: "Not filled", FAILED: "Failed", BOOT: "Started", KILL: "Killed",
};

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`);
const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;

function Gate({ checks, legend }: { checks: GuardianCheck[]; legend?: boolean }) {
  return (
    <>
      <div className="gate" role="list" aria-label="Guardian checks">
        {checks.map((c) => (
          <button key={c.id} role="listitem" className="seg" data-pass={c.passed} title={`${c.name}: ${c.value} (needs ${c.threshold})`} aria-label={`${c.name} ${c.passed ? "passed" : "failed"}: ${c.value}`} />
        ))}
      </div>
      {legend && (
        <div className="gate-legend" aria-hidden="true">
          {checks.map((c) => (
            <span key={c.id} data-pass={c.passed}>{SHORT[c.id] ?? c.name}</span>
          ))}
        </div>
      )}
    </>
  );
}

function Mini({ checks }: { checks: GuardianCheck[] }) {
  return (
    <span className="mini" aria-hidden="true">
      {checks.map((c) => <i key={c.id} data-pass={c.passed} />)}
    </span>
  );
}

type Proof = { hash: boolean; sig: boolean; replay: boolean | null; chain?: boolean };

function verifyInBrowser(a: Artifact, prev?: Artifact): Proof {
  const v = verifyArtifact(a, prev);
  let replay: boolean | null = null;
  if (a.kind === "decision") {
    const b = a.body as unknown as DecisionBody;
    if (b.inputs) replay = JSON.stringify(sortKeys(evaluate(b.inputs))) === JSON.stringify(sortKeys(b.decision));
  }
  return { hash: v.hashOk, sig: v.signatureOk, replay, chain: v.chainOk };
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return typeof v === "number" && !Number.isFinite(v) ? null : v;
}

function Row({ a, prev }: { a: Artifact; prev?: Artifact }) {
  const [open, setOpen] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const isDecision = a.kind === "decision";
  const b = a.body as Record<string, any>;
  const d: GuardianDecision | undefined = isDecision ? b.decision : undefined;
  const label = a.verdict ?? a.kind.toUpperCase();

  let title = a.symbol ?? "";
  let line = "";
  if (isDecision && d) {
    title = `${d.symbol} ${d.side}`;
    line = b.explanation?.text ?? "";
  } else if (a.kind === "execution") {
    title = `${a.symbol} bracket order sent`;
    line = `Size ${b.plan?.size}, stop ${b.plan?.stopPrice}, target ${b.plan?.takeProfitPrice}. Strike sequence #${a.strike?.sequence_id}.`;
  } else if (a.kind === "outcome") {
    title = `${a.symbol} position closed`;
    line = `${b.result === "not_filled" ? "Entry never filled." : `${b.pnlUsdApprox >= 0 ? "+" : ""}${money(b.pnlUsdApprox)} after ${b.heldMinutes} min (approx., from equity change).`}`;
  } else if (a.kind === "boot") {
    title = `Agent started (${b.live ? "live" : "dry run"})`;
    line = `Watching ${(b.watchlist ?? []).join(", ")} on ${b.interval} candles. Policy ${String(b.policyHash).slice(0, 10)}.`;
  } else if (a.kind === "kill") {
    title = "Kill switch";
    line = "All orders cancelled and positions closed. Agent paused.";
  } else if (a.kind === "error") {
    title = `${a.symbol ?? ""} ${b.stage} failed`;
    line = String(b.error ?? "");
  }

  return (
    <li className="row">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="t">{time(a.createdAt)}</span>
        <span className="v" data-v={label}>{WORD[label] ?? label}</span>
        <span className="what">
          <strong>{title}</strong>
          {line && <p>{line}</p>}
        </span>
        {d && <Mini checks={d.checks} />}
      </button>
      {open && (
        <div className="detail">
          {line && <p>{line}</p>}
          {d && (
            <table className="checks">
              <tbody>
                {d.checks.map((c) => (
                  <tr key={c.id} data-pass={c.passed}>
                    <td>{c.passed ? "✓" : "✗"}</td>
                    <td>{c.name}</td>
                    <td>{c.value}</td>
                    <td className="dim">needs {c.threshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="facts">
            {d?.plan && (<><dt>Order</dt><dd>{d.plan.side} {d.plan.size} at market, {d.plan.leverage}x isolated, risking {money(d.plan.riskUsd)}{d.plan.sizedToExchangeMinimum ? " (Strike minimum size)" : ""}</dd></>)}
            {isDecision && b.inputs?.proposal && (<><dt>Proposal</dt><dd>{b.inputs.proposal.thesis} Confidence {b.inputs.proposal.confidence}.</dd></>)}
            {isDecision && (<><dt>Explained by</dt><dd>{b.explanation?.source === "template" ? "fixed template" : b.explanation?.source}, after the verdict was set</dd></>)}
            {a.strike?.sequence_id !== undefined && (<><dt>Strike sequence</dt><dd>#{a.strike.sequence_id}, message {a.strike.message_id}</dd></>)}
            <dt>Receipt</dt>
            <dd>#{a.seq}, hash {a.hash.slice(0, 16)}…{d ? `, policy ${d.policyHash.slice(0, 10)}` : ""}</dd>
          </dl>
          <div className="proof">
            <button className="ghost" onClick={() => setProof(verifyInBrowser(a, prev))}>Verify in this browser</button>
            {proof && (
              <span>
                <span className={proof.hash ? "ok" : "bad"}>hash {proof.hash ? "✓" : "✗"}</span>{"  "}
                <span className={proof.sig ? "ok" : "bad"}>signature {proof.sig ? "✓" : "✗"}</span>{"  "}
                {proof.chain !== undefined && <><span className={proof.chain ? "ok" : "bad"}>chain {proof.chain ? "✓" : "✗"}</span>{"  "}</>}
                {proof.replay !== null && <span className={proof.replay ? "ok" : "bad"}>Guardian re-run {proof.replay ? "gives the same verdict ✓" : "differs ✗"}</span>}
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function Page() {
  const [state, setState] = useState<State | null>(null);
  const [items, setItems] = useState<Artifact[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([fetch("/api/state").then((r) => r.json()), fetch("/api/feed?limit=60").then((r) => r.json())]);
      setState(s);
      setItems((old) => {
        const older = old.filter((o) => !f.items.some((n: Artifact) => n.seq === o.seq) && o.seq < (f.items.at(-1)?.seq ?? 0));
        return [...f.items, ...older];
      });
      setErr(null);
    } catch {
      setErr("Can't reach the ledger right now. Retrying every 10 seconds.");
    }
  }, []);

  useEffect(() => {
    load();
    const a = setInterval(load, 10_000);
    const b = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [load]);

  const loadOlder = async () => {
    const before = items.at(-1)?.seq;
    if (!before) return;
    const f = await fetch(`/api/feed?limit=60&before=${before}`).then((r) => r.json());
    setItems((x) => [...x, ...f.items]);
  };

  const control = async (action: "kill" | "pause" | "resume") => {
    const msg = action === "kill" ? "Cancel every order, close every position and pause the agent?" : action === "pause" ? "Pause the agent? Open positions keep their stops." : "Let the agent trade again?";
    if (!confirm(msg)) return;
    const token = prompt("Admin token");
    if (!token) return;
    const r = await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action }) });
    const j = await r.json();
    alert(r.ok ? (action === "kill" ? "Kill switch set. The agent acts on its next cycle (within a minute)." : action === "pause" ? "Paused." : "Resumed.") : j.error);
    load();
  };

  const latest = useMemo(() => items.find((a) => a.kind === "decision") as Artifact<DecisionBody> | undefined, [items]);
  const hb = state?.heartbeat;
  const hbAge = hb ? now - hb.at : Infinity;
  const pulse = !hb ? "idle" : hbAge < 180_000 ? "ok" : "stale";
  const v = state?.stats.verdicts ?? { APPROVE: 0, BLOCK: 0, PAUSE: 0 };
  const maxFail = Math.max(1, ...(state?.stats.failedBy.map((f) => f.count) ?? [1]));
  const dayPnl = hb && state?.risk ? hb.equity - state.risk.dayStartEquity : null;

  return (
    <main className="wrap">
      <header className="bar">
        <h1 className="mark">Strike Guardian</h1>
        <span className="status">
          <span className="pulse" data-state={pulse} aria-hidden="true" />
          {!hb ? "Waiting for the agent's first check-in" : `${hb.live ? "Trading live" : "Dry run"} on Strike ${hb.network}${hb.paused ? ", paused" : ""}. Last check ${ago(hbAge)}.`}
        </span>
        <span className="spacer" />
        {hb?.paused ? <button className="ghost" onClick={() => control("resume")}>Resume</button> : <button className="ghost" onClick={() => control("pause")}>Pause</button>}
        <button className="kill" onClick={() => control("kill")}>Kill switch</button>
      </header>
      {pulse === "stale" && <p className="banner" role="status">The agent hasn't checked in for {ago(hbAge).replace(" ago", "")}. Positions still have exchange-side stops; restart the agent with <b>npm run agent</b>.</p>}
      {err && <p className="banner" role="status">{err}</p>}

      <section className="hero" aria-live="polite">
        {latest ? (
          <>
            <p className="hero-meta">Latest decision, {time(latest.createdAt)}: {latest.body.decision.symbol} {latest.body.decision.side}, confidence {latest.body.inputs?.proposal.confidence ?? "n/a"}, {latest.body.decision.passed} of {latest.body.decision.total} checks passed</p>
            <h2 key={latest.seq} className="stamp stamp-in" data-v={latest.body.decision.verdict}>{WORD[latest.body.decision.verdict]}</h2>
            <p className="hero-why">{latest.body.explanation.text}</p>
            <Gate checks={latest.body.decision.checks} legend />
            {latest.body.decision.verdict !== "APPROVE" && (
              <ul className="fails">
                {latest.body.decision.checks.filter((c) => !c.passed).map((c) => (
                  <li key={c.id}><b>{c.name}:</b> {c.value}, needs {c.threshold}.</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <h2 className="stamp" data-v="APPROVE" style={{ color: "var(--ink-3)" }}>Watching</h2>
            <p className="hero-empty">No trade proposals yet. The agent proposes when a 5-minute candle closes into a trend setup, and every proposal must pass all 13 Guardian checks before an order reaches Strike.</p>
          </>
        )}
      </section>

      <div className="cols">
        <div>
          <h2>Track record</h2>
          <p className="summary">
            {state && state.stats.decisions > 0 ? (
              <>The proposer suggested {state.stats.decisions} trades. The Guardian <span className="a">approved {v.APPROVE}</span>, <span className="b">blocked {v.BLOCK}</span>{v.PAUSE ? <> and <span className="p">paused trading on {v.PAUSE}</span></> : null}. {state.stats.executions} orders reached Strike{state.stats.outcomes.wins + state.stats.outcomes.losses > 0 ? `, ${state.stats.outcomes.wins} closed in profit and ${state.stats.outcomes.losses} at a loss` : ""}.</>
            ) : (
              "Nothing judged yet."
            )}
          </p>
          {state && state.stats.failedBy.length > 0 && (
            <>
              <h2>Why trades were stopped</h2>
              <ul className="reasons">
                {state.stats.failedBy.map((f) => (
                  <li key={f.id}>
                    <span>{f.name}</span>
                    <span className="track"><span className="fill" style={{ display: "block", width: `${(f.count / maxFail) * 100}%` }} /></span>
                    <span className="n">{f.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2>Ledger</h2>
          <ol className="feed" reversed>
            {items.map((a, i) => <Row key={a.seq} a={a} prev={items[i + 1]?.seq === a.seq - 1 ? items[i + 1] : undefined} />)}
          </ol>
          {items.length > 0 && items.at(-1)!.seq > 1 && <button className="ghost more" onClick={loadOlder}>Show older entries</button>}
        </div>

        <aside className="rail">
          <section>
            <h2>Account</h2>
            <p className="big">{hb ? money(hb.equity) : "n/a"}</p>
            <p className="sub">{dayPnl === null ? "Equity" : `Equity, ${dayPnl >= 0 ? "up" : "down"} ${money(Math.abs(dayPnl))} today`}</p>
            <dl className="kv">
              <dt>Available</dt><dd>{hb ? money(hb.available) : "n/a"}</dd>
              <dt>Loss streak</dt><dd>{state?.risk?.consecutiveLosses ?? 0}</dd>
              <dt>Approx. P&amp;L closed</dt><dd>{state ? money(state.stats.outcomes.total) : "n/a"}</dd>
            </dl>
          </section>
          <section>
            <h2>Open positions</h2>
            {hb && hb.positions.length ? (
              <ul className="pos">
                {hb.positions.map((p) => (
                  <li key={p.symbol}><span>{p.symbol} {Number(p.size) > 0 ? "long" : "short"} {p.size.replace("-", "")}</span><span className={Number(p.upnl) >= 0 ? "up" : "down"}>{Number(p.upnl) >= 0 ? "+" : ""}{Number(p.upnl).toFixed(3)}</span></li>
                ))}
              </ul>
            ) : <p className="sub">None. Every position opens with a stop-loss already on Strike.</p>}
          </section>
          <section>
            <h2>Markets watched</h2>
            <dl className="kv">
              {hb && Object.entries(hb.markets).map(([s, m]) => (<><dt key={s + "k"}>{s}</dt><dd key={s + "v"}>{m.mark ? Number(m.mark).toLocaleString(undefined, { maximumSignificantDigits: 6 }) : "n/a"}</dd></>))}
            </dl>
            <p className="key">Only BTC, ETH and SOL can be traded. The others are watched so you can see the Guardian refuse them.</p>
          </section>
          <section>
            <h2>Signing key</h2>
            <p className="sub">Every entry is signed with this Ed25519 key. It can sign receipts but can't touch the Strike account.</p>
            <p className="key">{hb?.attestPubKey ?? "n/a"}</p>
          </section>
        </aside>
      </div>
    </main>
  );
}
