/**
 * Generate the Guardian ATTESTATION key (signs decision receipts; has no access to Strike).
 *   npm run keygen:attest
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeys } from "../lib/strike/auth.ts";

const ENV = ".env";
let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
if (/^GUARDIAN_ATTEST_PRIVATE_KEY=\S+/m.test(env) && !process.argv.includes("--force")) {
  console.error("GUARDIAN_ATTEST_PRIVATE_KEY already set. Use --force to replace (breaks verification of old artifacts' key continuity).");
  process.exit(1);
}
const k = generateKeys();
const set = (key: string, v: string) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  env = re.test(env) ? env.replace(re, `${key}=${v}`) : env + (env && !env.endsWith("\n") ? "\n" : "") + `${key}=${v}\n`;
};
set("GUARDIAN_ATTEST_PRIVATE_KEY", k.privateKey);
set("GUARDIAN_ATTEST_PUBLIC_KEY", k.publicKey);
writeFileSync(ENV, env, { mode: 0o600 });
console.log(`\nAttestation key written to .env. Public key (published in every artifact):\n  ${k.publicKey}\n`);
