/**
 * Kill switch.
 *   npm run kill            → flags the running agent: it cancels all orders, flattens all positions, pauses
 *   npm run kill -- --now   → does it directly from this machine as well (use if the agent is down)
 *   npm run resume          → clears the pause flag
 */
import "dotenv/config";
import { openStore } from "../lib/artifacts/store.ts";
import { StrikeClient } from "../lib/strike/client.ts";
import { loadKeysFromEnv } from "../lib/strike/auth.ts";

const store = openStore();
await store.init();
if (process.argv.includes("--resume")) {
  await store.setState("control", { paused: false, kill: false });
  console.log("Resumed: agent will trade on its next cycle.");
} else {
  await store.setState("control", { paused: true, kill: true });
  console.log("Kill flag set: the agent will cancel orders, flatten positions and pause on its next cycle.");
  if (process.argv.includes("--now")) {
    const s = new StrikeClient({ keys: loadKeysFromEnv(), subAccountId: process.env.STRIKE_SUB_ACCOUNT_ID });
    await s.syncClock();
    console.log(JSON.stringify(await s.killSwitch(), null, 2));
  }
}
await store.close();
