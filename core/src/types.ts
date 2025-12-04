export type DetectorLevel = 'ok' | 'warn' | 'alert'

export interface TokenTx {
  signature: string
  amount: number
  from: string
  to: string
  blockTime?: number
  slot?: number
  raw?: any
}

export interface DexPair {
  dexId?: string
  url?: string
  liquidityUsd?: number
  volume24h?: number
  priceUsd?: number
  priceChange24h?: number
  baseSymbol?: string
  quoteSymbol?: string
  pairAddress?: string
  fdv?: number
  marketCap?: number
}

export interface DetectorResult {
  level: DetectorLevel
  title: string
  explanation: string
  items?: Array<{ label: string; value: string }>
  metrics?: Record<string, number | string | null>
}
