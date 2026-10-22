import { getStore, noStore } from "../_store.ts";
import type { Artifact } from "../../../lib/artifacts/artifact.ts";
import type { GuardianDecision } from "../../../lib/guardian/engine.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/state — heartbeat, control flags, risk state and aggregate stats. Public, read-only. */
export async function GET() {
  const store = await getStore();
  const [heartbeat, control, risk, decisions, outcomes, executions, boot] = await Promise.all([
    store.getState("heartbeat"),
    store.getState("control"),
    store.getState("risk"),
    store.list({ kind: "decision", limit: 500 }),
    store.list({ kind: "outcome", limit: 200 }),
    store.list({ kind: "execution", limit: 200 }),
    store.list({ kind: "boot", limit: 1 }),
  ]);

  const verdicts: Record<string, number> = { APPROVE: 0, BLOCK: 0, PAUSE: 0 };
  const failedBy: Record<string, { name: string; count: number }> = {};
  for (const a of decisions as Artifact<{ decision: GuardianDecision }>[]) {
    const d = a.body.decision;
    verdicts[d.verdict] = (verdicts[d.verdict] ?? 0) + 1;
    if (d.verdict === "APPROVE") continue;
    for (const c of d.checks) {
      if (c.passed) continue;
      failedBy[c.id] ??= { name: c.name, count: 0 };
      failedBy[c.id].count++;
    }
  }
  const pnl = (outcomes as Artifact<{ pnlUsdApprox: number; result: string }>[]).reduce(
    (s, o) => ({ total: s.total + (o.body.pnlUsdApprox ?? 0), wins: s.wins + (o.body.result === "win" ? 1 : 0), losses: s.losses + (o.body.result === "loss" ? 1 : 0) }),
    { total: 0, wins: 0, losses: 0 }
  );

  return Response.json(
    {
      heartbeat,
      control: control ?? {},
      risk,
      boot: boot[0] ?? null,
      stats: {
        decisions: decisions.length,
        verdicts,
        failedBy: Object.entries(failedBy).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.count - a.count),
        executions: executions.length,
        outcomes: pnl,
      },
      serverTime: Date.now(),
    },
    { headers: noStore }
  );
}
