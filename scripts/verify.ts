/**
 * Independently verify the artifact ledger:
 *   1. every hash recomputes from the artifact's own content
 *   2. every Ed25519 signature verifies against the published attestation key
 *   3. every artifact links to the previous one (seq + prevHash) — nothing inserted or deleted
 *   4. every decision REPLAYS: re-running the Guardian on its recorded inputs gives the same verdict & checks
 *
 *   npm run verify
 */
import "dotenv/config";
import { isDeepStrictEqual } from "node:util";
import { openStore } from "../lib/artifacts/store.ts";
import { verifyArtifact, type Artifact } from "../lib/artifacts/artifact.ts";
import { evaluate, type GuardianContext, type GuardianDecision } from "../lib/guardian/engine.ts";

const store = openStore();
await store.init();
const all: Artifact[] = [];
let before: number | undefined;
for (;;) {
  const page = await store.list({ limit: 500, beforeSeq: before });
  if (!page.length) break;
  all.push(...page);
  before = page.at(-1)!.seq;
}
all.reverse();

let bad = 0;
let replayed = 0;
let replayMismatch = 0;
const verdicts: Record<string, number> = {};

for (let i = 0; i < all.length; i++) {
  const a = all[i];
  const v = verifyArtifact(a, i > 0 ? all[i - 1] : undefined);
  if (!(v.hashOk && v.signatureOk && (v.chainOk ?? true))) {
    bad++;
    console.log(`✗ seq ${a.seq} ${a.kind}: hash ${v.hashOk} sig ${v.signatureOk} chain ${v.chainOk}`);
  }
  if (a.kind === "decision") {
    verdicts[a.verdict ?? "?"] = (verdicts[a.verdict ?? "?"] ?? 0) + 1;
    const body = a.body as { inputs?: GuardianContext; decision: GuardianDecision };
    if (body.inputs) {
      replayed++;
      const again = evaluate(body.inputs);
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(again)), body.decision)) {
        replayMismatch++;
        console.log(`✗ seq ${a.seq} replay mismatch: recorded ${body.decision.verdict}, replay ${again.verdict}`);
      }
    }
  }
}

console.log(`\n${all.length} artifacts · ${bad === 0 ? "all hashes, signatures and chain links valid ✓" : `${bad} INVALID ✗`}`);
console.log(`${replayed} decisions replayed · ${replayMismatch === 0 ? "every verdict reproduced exactly ✓" : `${replayMismatch} MISMATCH ✗`}`);
console.log(`verdicts: ${Object.entries(verdicts).map(([k, n]) => `${k} ${n}`).join(", ") || "none yet"}`);
await store.close();
process.exit(bad || replayMismatch ? 1 : 0);
