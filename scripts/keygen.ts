/**
 * Generate an Ed25519 API-wallet key pair and write it into .env.
 *
 *   npm run keygen
 *
 * The PRIVATE key goes into .env only (gitignored) — it is never printed.
 * The PUBLIC key is printed so you can paste it into Strike's API Wallets page.
 * Refuses to overwrite an existing key unless you pass --force.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeys } from "../lib/strike/auth.ts";

const ENV = ".env";
const force = process.argv.includes("--force");
let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";

if (/^STRIKE_API_PRIVATE_KEY=\S+/m.test(env) && !force) {
  console.error("A STRIKE_API_PRIVATE_KEY already exists in .env. Re-run with --force to replace it.");
  process.exit(1);
}

const keys = generateKeys();
const set = (k: string, v: string) => {
  const line = `${k}=${v}`;
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), line) : env + (env.endsWith("\n") || !env ? "" : "\n") + line + "\n";
};
set("STRIKE_API_PRIVATE_KEY", keys.privateKey);
set("STRIKE_API_PUBLIC_KEY", keys.publicKey);
writeFileSync(ENV, env, { mode: 0o600 });

console.log("\nNew API wallet written to .env (private key NOT shown).\n");
console.log("Paste this PUBLIC key into Strike → API Wallets:\n");
console.log("  " + keys.publicKey + "\n");
