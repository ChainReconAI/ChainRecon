import type { DetectorLevel, DetectorResult, DexPair, TokenTx } from './types'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const sumVolume = (txs: TokenTx[]) =>
  txs.reduce((acc, tx) => acc + Math.abs(Number(tx.amount) || 0), 0)

const fmtNum = (value: number) =>
  Math.abs(value) >= 1000 ? `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : value.toFixed(2)

const fmtUsd = (value: number) =>
  value >= 1000
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : `$${value.toFixed(2)}`

export function detectWhaleMoves(
  txs: TokenTx[],
  opts: { thresholdTokens?: number; thresholdUsd?: number; priceUsd?: number; maxItems?: number } = {},
): DetectorResult {
  const thresholdTokens = opts.thresholdTokens ?? 10_000
  const thresholdUsd = opts.thresholdUsd ?? 50_000
  const priceUsd = opts.priceUsd
  const maxItems = opts.maxItems ?? 10

  const ordered = [...txs]
    .map((tx) => ({
      signature: tx.signature,
      amount: Math.abs(Number(tx.amount) || 0),
      usd: priceUsd ? Math.abs(Number(tx.amount) || 0) * priceUsd : null,
      from: tx.from,
      to: tx.to,
      time: tx.blockTime,
    }))
    .sort((a, b) => (b.usd ?? b.amount) - (a.usd ?? a.amount))

  const breaches = ordered.filter((tx) =>
    priceUsd ? (tx.amount * priceUsd >= thresholdUsd) : tx.amount >= thresholdTokens,
  )

  const hasSevere = breaches.some((tx) =>
    priceUsd
      ? tx.amount * priceUsd >= thresholdUsd * 1.5
      : tx.amount >= thresholdTokens * 3,
  )
  const level: DetectorLevel = hasSevere ? 'alert' : breaches.length > 0 ? 'warn' : 'ok'

  const thresholdLabel = priceUsd
    ? `${fmtUsd(thresholdUsd)} (amount × price ${priceUsd.toFixed(4)})`
    : `${fmtNum(thresholdTokens)} tokens`

  const explanation = `Whale rule: flag any single tx where size >= ${thresholdLabel}. Using size = amount${
    priceUsd ? ' × priceUsd' : ''
  }. ${breaches.length} / ${txs.length} txs breach the threshold.`

  return {
    level,
    title: 'Whale Moves',
    explanation,
    items: ordered.slice(0, maxItems).map((tx) => ({
      label: tx.signature,
      value: `${fmtNum(tx.amount)} ${priceUsd ? `(${fmtUsd(tx.amount * priceUsd)})` : 'tokens'}`,
    })),
    metrics: {
      thresholdTokens,
      thresholdUsd,
      priceUsd: priceUsd ?? null,
      breaches: breaches.length,
    },
  }
}

export function detectVolumeSpike(
  txs: TokenTx[],
  opts: { windowSize?: number } = {},
): DetectorResult {
  const windowSize = opts.windowSize ?? 20
  const recent = txs.slice(0, windowSize)
  const previous = txs.slice(windowSize, windowSize * 2)

  const recentVol = sumVolume(recent)
  const previousVol = sumVolume(previous)

  const changePct =
    previousVol === 0 ? (recentVol > 0 ? 100 : 0) : ((recentVol - previousVol) / previousVol) * 100

  const level: DetectorLevel =
    changePct >= 60 ? 'alert' : changePct >= 30 ? 'warn' : 'ok'

  const explanation = `Volume spike = ((recent ${fmtNum(recentVol)} - previous ${fmtNum(
    previousVol,
  )}) / previous) × 100 = ${changePct.toFixed(1)}%. Alert if ≥ 60%, warn if ≥ 30%.`

  return {
    level,
    title: 'Volume Spike',
    explanation,
    metrics: {
      recentVol: Number(recentVol.toFixed(2)),
      previousVol: Number(previousVol.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      windowSize,
    },
  }
}

export function detectVolumeDip(
  txs: TokenTx[],
  opts: { windowSize?: number } = {},
): DetectorResult {
  const windowSize = opts.windowSize ?? 20
  const recent = txs.slice(0, windowSize)
  const previous = txs.slice(windowSize, windowSize * 2)

  const recentVol = sumVolume(recent)
  const previousVol = sumVolume(previous)

  const changePct =
    previousVol === 0 ? (recentVol === 0 ? 0 : -100) : ((recentVol - previousVol) / previousVol) * 100

  const level: DetectorLevel =
    changePct <= -60 ? 'alert' : changePct <= -30 ? 'warn' : 'ok'

  const explanation = `Volume dip = ((recent ${fmtNum(recentVol)} - previous ${fmtNum(
    previousVol,
  )}) / previous) × 100 = ${changePct.toFixed(1)}%. Alert if ≤ -60%, warn if ≤ -30%.`

  return {
    level,
    title: 'Volume Dip',
    explanation,
    metrics: {
      recentVol: Number(recentVol.toFixed(2)),
      previousVol: Number(previousVol.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      windowSize,
    },
  }
}

export function computeMarketScore(pair?: DexPair) {
  if (!pair) {
    return {
      score0to100: 0,
      explanation: 'No Dexscreener pair available; score defaults to 0.',
    }
  }

  const liquidity = Math.max(pair.liquidityUsd ?? 0, 0)
  const volume = Math.max(pair.volume24h ?? 0, 0)
  const change = pair.priceChange24h ?? 0
  const fdv = Math.max(pair.fdv ?? 0, 0)

  const liqScore = clamp(liquidity / 500_000, 0, 1) * 35
  const volScore = clamp(volume / 1_000_000, 0, 1) * 35
  const changeScore = clamp((50 + change) / 100, 0, 1) * 15
  const fdvScore = clamp(fdv / 5_000_000, 0, 1) * 10

  const rawScore = liqScore + volScore + changeScore + fdvScore
  const score0to100 = Math.round(clamp(rawScore, 0, 100))

  const explanation = `(liq/500k)*35 + (vol/1M)*35 + ((50 + change%)/100)*15 + (fdv/5M)*10 = ${score0to100} (liq ${fmtUsd(
    liquidity,
  )}, vol ${fmtUsd(volume)}, change ${change.toFixed(1)}%, fdv ${fmtUsd(fdv)}).`

  return { score0to100, explanation }
}
