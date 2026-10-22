# Strike Guardian

An autonomous perps agent on [Strike Finance](https://strikefinance.org) where **no trade reaches the order book without passing a deterministic Guardian**. The AI proposes, the Guardian decides, and every decision leaves an Ed25519-signed receipt stamped with Strike's `sequence_id`.

> Status: Phase 0 (connectivity + signing). Full README lands before submission.

## Quick start

```bash
npm install
npm test            # signing tests incl. RFC 8032 vector
npm run keygen      # writes a fresh API wallet into .env, prints the public key
npm run smoke       # read-only go/no-go check against Strike testnet
```

Switch to mainnet with `STRIKE_NETWORK=mainnet` in `.env`.

## Safety

- API-wallet keys can trade but **cannot withdraw or deposit**.
- `.env` is gitignored; the private key is never printed or logged.
- The smoke test is read-only.
