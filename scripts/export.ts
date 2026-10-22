/**
 * Export the signed ledger + dashboard state to one file, for offline rendering (e.g. the demo video).
 * Contains NO secrets: artifacts are public receipts, state is what the dashboard already shows.
 *   npm run export   →  ledger-export.json
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { openStore } from "../lib/artifacts/store.ts";
import type { Artifact } from "../lib/artifacts/artifact.ts";

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
const state = {
  heartbeat: await store.getState("heartbeat"),
  control: await store.getState("control"),
  risk: await store.getState("risk"),
};
writeFileSync("ledger-export.json", JSON.stringify({ exportedAt: Date.now(), artifacts: all, state }));
console.log(`ledger-export.json written: ${all.length} artifacts (no secrets inside).`);
await store.close();
