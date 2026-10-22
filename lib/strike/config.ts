/**
 * Strike endpoints. Testnet by default; set STRIKE_NETWORK=mainnet to switch.
 * Hosts and paths mirror strike-finance/strike-builder-reference (src/api/config.ts).
 *
 * API_BASE must be an ORIGIN only — API-wallet signatures cover the path exactly
 * as the server sees it, so a path prefix here would break every signature.
 */

export type StrikeNetwork = "testnet" | "mainnet";

const HOSTS: Record<StrikeNetwork, string> = {
  testnet: "api-v2-testnet.strikefinance.org",
  mainnet: "api.strikefinance.org",
};

export interface StrikeConfig {
  network: StrikeNetwork;
  apiBase: string; // /v2/..., /auth/...  (trading, account, orders)
  priceBase: string; // /price/v2/... (depth, klines, markPrice) — public
  priceWs: string; // public market stream
  userWs: string; // API-wallet user stream (session.logon). NOT /ws/user (that one is JWT-only)
  statsBase: string; // /stat/v1/...
}

export function getStrikeConfig(network?: string): StrikeConfig {
  const n = (network ?? process.env.STRIKE_NETWORK ?? "testnet").toLowerCase();
  if (n !== "testnet" && n !== "mainnet") {
    throw new Error(`STRIKE_NETWORK must be "testnet" or "mainnet", got "${n}"`);
  }
  const host = HOSTS[n];
  return {
    network: n,
    apiBase: `https://${host}`,
    priceBase: `https://${host}/price`,
    priceWs: `wss://${host}/ws/price`,
    userWs: `wss://${host}/ws/user-api`,
    statsBase: `https://${host}/stat`,
  };
}
