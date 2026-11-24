import { chebyshevBasis } from './design'

export function baselineLevelMax(y: number[]): number {
  return Math.max(0.5, Math.max(0, ...y) * 1.25)
}

export function evaluateBaseline(t: number[], coefficients: number[]): number[] {
  if (coefficients.length === 0) return t.map(() => 0)
  const cols = chebyshevBasis(t, coefficients.length - 1)
  return t.map((_, i) => coefficients.reduce((s, c, j) => s + c * cols[j][i], 0))
}

export function baselineDrift(baseline: number[]): number {
  if (baseline.length === 0) return 0
  return Math.max(...baseline) - Math.min(...baseline)
}

export function baselineTilt(baseline: number[]): number {
  if (baseline.length < 2) return 0
  return baseline[baseline.length - 1] - baseline[0]
}
