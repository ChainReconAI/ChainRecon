import type { DexPair, TokenTx } from './types'

const SOLANA_BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const envRpc =
  (typeof process !== 'undefined' && process.env?.CHAINRECON_RPC) ||
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SOLANA_RPC)

const RPC_ENDPOINTS = [
  envRpc,
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-api.projectserum.com',
  'https://solana.public-rpc.com',
].filter(Boolean) as string[]

const normalizeBlockTime = (blockTime?: number | null) => {
  if (!blockTime) return undefined
  return blockTime < 1_000_000_000_000 ? blockTime * 1000 : blockTime
}

async function rpcRequest<T>(method: string, params: any[]) {
  let lastErr: unknown
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
      })
      if (!res.ok) {
        if ([401, 403, 429, 522, 525].includes(res.status)) {
          lastErr = new Error(`RPC ${method} failed ${res.status} at ${endpoint}`)
          continue
        }
        const text = await res.text()
        lastErr = new Error(`RPC ${method} failed ${res.status}: ${text.slice(0, 80)}`)
        continue
      }
      const json = await res.json()
      if (json.error) {
        lastErr = new Error(`RPC ${method} error at ${endpoint}: ${json.error?.message ?? 'unknown'}`)
        continue
      }
      return json.result as T
    } catch (error) {
      lastErr = error
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('RPC request failed')
}

export function isValidMint(address: string) {
  return SOLANA_BASE58_REGEX.test(address.trim())
}

function parseTokenTx(tx: any, mint: string): TokenTx | null {
  const meta = tx?.meta
  if (!meta) return null
  const pre = meta.preTokenBalances ?? []
  const post = meta.postTokenBalances ?? []
  const balanceMap = new Map<
    number,
    {
      pre: number
      post: number
      owner?: string
    }
  >()

  for (const entry of pre) {
    if (entry.mint !== mint) continue
    balanceMap.set(entry.accountIndex, {
      pre: Number(entry.uiTokenAmount?.uiAmount ?? 0),
      post: 0,
      owner: entry.owner,
    })
  }
  for (const entry of post) {
    if (entry.mint !== mint) continue
    const existing = balanceMap.get(entry.accountIndex) ?? { pre: 0, post: 0 }
    balanceMap.set(entry.accountIndex, {
      ...existing,
      post: Number(entry.uiTokenAmount?.uiAmount ?? 0),
      owner: entry.owner ?? existing.owner,
    })
  }

  const deltas = [...balanceMap.entries()]
    .map(([idx, val]) => ({
      accountIndex: idx,
      delta: Number((val.post - val.pre).toFixed(9)),
      owner: val.owner,
    }))
    .filter((d) => d.delta !== 0)

  if (!deltas.length) return null

  const largestPositive = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta)[0]
  const largestNegative = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta)[0]
  const amount = Math.max(
    Math.abs(largestPositive?.delta ?? 0),
    Math.abs(largestNegative?.delta ?? 0),
    Math.max(...deltas.map((d) => Math.abs(d.delta))),
  )

  return {
    signature: tx.transaction?.signatures?.[0] ?? 'unknown',
    amount,
    from: largestNegative?.owner ?? 'unknown',
    to: largestPositive?.owner ?? 'unknown',
    blockTime: normalizeBlockTime(tx.blockTime),
    slot: tx.slot,
    raw: tx,
  }
}

async function fetchTopAccounts(mint: string, take = 8) {
  try {
    const largest = await rpcRequest<any>('getTokenLargestAccounts', [mint])
    const accounts: string[] = (largest?.value ?? []).map((v: any) => v.address).filter(Boolean)
    if (accounts.length) return accounts.slice(0, take)
  } catch {
    // fallback below
  }

  try {
    const resp = await rpcRequest<any>('getProgramAccounts', [
      TOKEN_PROGRAM_ID,
      {
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { dataSize: 165 },
          {
            memcmp: {
              offset: 0,
              bytes: mint,
            },
          },
        ],
      },
    ])
    const accounts: string[] = (resp ?? []).map((acc: any) => acc.pubkey).filter(Boolean)
    if (accounts.length) return accounts.slice(0, take)
  } catch {
    // ignore
  }

  return []
}

export async function fetchTokenTxs(mint: string, limit = 40) {
  const accounts = await fetchTopAccounts(mint, 8)
  if (!accounts.length) {
    throw new Error(
      'No token accounts found for this mint via RPC. Provide CHAINRECON_RPC/VITE_SOLANA_RPC with CORS enabled.',
    )
  }

  const signatures = new Set<string>()
  const sigWithTime: Array<{ sig: string; blockTime: number | null; account?: string }> = []
  for (const account of accounts) {
    if (signatures.size >= limit) break
    try {
      const sigs = await rpcRequest<any>('getSignaturesForAddress', [
        account,
        { limit: Math.min(10, limit), commitment: 'confirmed' },
      ])
      for (const entry of sigs ?? []) {
        if (!signatures.has(entry.signature)) {
          signatures.add(entry.signature)
          sigWithTime.push({ sig: entry.signature, blockTime: entry.blockTime ?? null, account })
        }
        if (signatures.size >= limit) break
      }
    } catch {
      continue
    }
  }

  const ordered = sigWithTime.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0)).slice(0, limit)
  const txs: TokenTx[] = []
  for (const { sig } of ordered) {
    try {
      const tx = await rpcRequest<any>('getTransaction', [
        sig,
        {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        },
      ])
      const parsed = parseTokenTx(tx, mint)
      if (parsed) txs.push(parsed)
    } catch {
      // ignore
    }
    if (txs.length >= limit) break
  }

  return {
    raw: { accounts, signatures: ordered },
    txs: txs.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0)),
  }
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Request failed (${response.status}): ${text.slice(0, 120)}`)
  }
  return (await response.json()) as T
}

export async function fetchDexscreenerPair(mint: string) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`
  const raw = await fetchJson<any>(url)
  const pairs = raw?.pairs ?? []

  const best = (pairs as Array<Record<string, any>>)
    .slice()
    .sort((a: Record<string, any>, b: Record<string, any>) => {
      const liqA = Number(a?.liquidity?.usd ?? a?.liquidityUsd ?? 0)
      const liqB = Number(b?.liquidity?.usd ?? b?.liquidityUsd ?? 0)
      const volA = Number(a?.volume?.h24 ?? a?.volume24h ?? 0)
      const volB = Number(b?.volume?.h24 ?? b?.volume24h ?? 0)
      return liqB - liqA || volB - volA
    })[0]

  const liquidityRaw = best?.liquidity?.usd ?? best?.liquidityUsd
  const volumeRaw = best?.volume?.h24 ?? best?.volume24h
  const priceRaw = best?.priceUsd ?? best?.price?.usd
  const changeRaw = best?.priceChange?.h24 ?? best?.priceChange24h
  const fdvRaw = best?.fdv

  const pair: DexPair | undefined = best
    ? {
        dexId: best.dexId,
        url: best.url,
        liquidityUsd: liquidityRaw !== undefined ? Number(liquidityRaw) : undefined,
        volume24h: volumeRaw !== undefined ? Number(volumeRaw) : undefined,
        priceUsd: priceRaw !== undefined ? Number(priceRaw) : undefined,
        priceChange24h: changeRaw !== undefined ? Number(changeRaw) : undefined,
        baseSymbol: best.baseToken?.symbol,
        quoteSymbol: best.quoteToken?.symbol,
        pairAddress: best.pairAddress,
        fdv: fdvRaw !== undefined ? Number(fdvRaw) : undefined,
        marketCap: best.marketCap !== undefined ? Number(best.marketCap) : best.fdv !== undefined ? Number(best.fdv) : undefined,
      }
    : undefined

  return { raw, pair }
}
