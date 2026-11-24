import { median, quantile } from './linalg'

export interface PathPoint {
  lambda: number
  score: number
}

/** Linear index of the minimum, or -1 for an empty path. */
export function argMinBy<T>(items: T[], score: (item: T) => number): number {
  let best = -1
  let bestScore = Number.POSITIVE_INFINITY
  items.forEach((item, i) => {
    const s = score(item)
    if (Number.isFinite(s) && s < bestScore) {
      bestScore = s
      best = i
    }
  })
  return best
}

/**
 * One-standard-error rule: choose the smoothest/sparsest parameter whose
 * score lies within `tolerance` (relative) of the best.
 */
export function oneSeChoice<T>(items: T[], score: (item: T) => number, tolerance = 0.02, preferLarger = true): number {
  const best = argMinBy(items, score)
  if (best < 0) return -1
  const target = score(items[best]) * (1 + tolerance)
  let chosen = best
  items.forEach((item, i) => {
    if (score(item) > target) return
    const lambda = (item as { lambda?: number }).lambda ?? 0
    const chosenLambda = (items[chosen] as { lambda?: number }).lambda ?? 0
    if (preferLarger ? lambda > chosenLambda : lambda < chosenLambda) chosen = i
  })
  return chosen
}

export function rms(values: number[]): number {
  if (values.length === 0) return 0
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length)
}

export function madSigma(values: number[]): number {
  const m = median(values)
  return (1.4826 * median(values.map((v) => Math.abs(v - m)))) || 0
}

export function robustScale(values: number[]): number {
  return Math.max(madSigma(values), 1e-9)
}

export function chunkMedian(values: number[], chunk: number): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i += chunk) {
    out.push(median(values.slice(i, i + chunk)))
  }
  return out
}

export function describeQuantiles(values: number[]): { p05: number; p50: number; p95: number } {
  return { p05: quantile(values, 0.05), p50: quantile(values, 0.5), p95: quantile(values, 0.95) }
}

