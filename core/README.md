# ChainRecon Core (detectors + data fetchers)

Minimal, open-source slice of the ChainRecon project: pure TypeScript utilities for fetching Solana token data and running detectors (whale moves, volume spikes/dips, market score). No UI, no build system assumptions.

## What’s inside
- `api.ts` — lightweight fetchers:
  - `fetchTokenTxs(mint, limit?)`: pulls recent token transfers via Solana RPC (no key needed; accepts optional env `CHAINRECON_RPC` or `VITE_SOLANA_RPC` for custom endpoint).
  - `fetchDexscreenerPair(mint)`: gets best pair data from Dexscreener.
  - `isValidMint(address)`: basic base58 length/charset check.
- `detectors.ts` — heuristic engine:
  - `detectWhaleMoves`, `detectVolumeSpike`, `detectVolumeDip`, `computeMarketScore`.
- `types.ts` — shared DTOs.
- `index.ts` — convenience exports.

## Quick use
```ts
import { fetchTokenTxs, fetchDexscreenerPair, detectWhaleMoves, detectVolumeSpike, detectVolumeDip, computeMarketScore } from './dist/index.js'

const mint = 'So11111111111111111111111111111111111111112' // wSOL demo

const { txs } = await fetchTokenTxs(mint, 30)
const { pair } = await fetchDexscreenerPair(mint)

const whale = detectWhaleMoves(txs, { priceUsd: pair?.priceUsd })
const spike = detectVolumeSpike(txs)
const dip = detectVolumeDip(txs)
const score = computeMarketScore(pair)

console.log({ whale, spike, dip, score })
```

## RPC notes
- Defaults to public RPCs (`api.mainnet-beta`, ankr, serum, solana.public-rpc). You can set `CHAINRECON_RPC` (Node) or `VITE_SOLANA_RPC` (Vite/ESM) to override.
- The Solana JSON-RPC fetch uses `fetch` (Node 18+ has it built-in).
- `fetchTokenTxs` uses a watchlist strategy: fetch top token accounts (largest or program-scan fallback), then collect recent signatures per account and parse SPL transfer deltas.

## Build / bundle
These files are plain TS. In your app, compile or bundle as you like (tsc, esbuild, Vite, etc.). No external deps beyond the runtime `fetch`.
