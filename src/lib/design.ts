import type {
  Dataset,
  FitConfig,
  IdentifiabilityReport,
  IdentifiableGroup,
  LibraryVersion,
  WavelengthRange,
  ReferenceSpectrum,
  Sample,
  ComponentCoverage,
} from './types'
import {
  effectiveRankFromGram,
  invertMatrix,
  median,
  solveLinear,
  symmetricEigen,
  zeros,
  zeros2,
} from './linalg'

/** Pairwise correlation at or above this is treated as unseparable. */
export const IDENT_CORR_THRESHOLD = 0.995
/** Pairwise normalised condition number at or above this is unseparable. */
export const IDENT_CONDITION_THRESHOLD = 20
/** Multiple R² against the baseline subspace above this = absorbed. */
export const BASELINE_ABSORB_R2 = 0.99985
export const MIN_POINTS = 24

export function chebyshevBasis(t: number[], degree: number): number[][] {
  const cols: number[][] = [t.map(() => 1)]
  if (degree >= 1) cols.push(t.map((v) => v))
  for (let j = 2; j <= degree; j++) {
    const prev = cols[j - 1]
    const prev2 = cols[j - 2]
    cols.push(t.map((v, i) => 2 * v * prev[i] - prev2[i]))
  }
  return cols
}

export function isMasked(wavelength: number, masks: WavelengthRange[]): boolean {
  return masks.some((m) => wavelength >= m.from && wavelength <= m.to)
}

export function usableIndices(
  dataset: Dataset,
  validRange: [number, number],
  masks: WavelengthRange[],
): number[] {
  const out: number[] = []
  for (let i = 0; i < dataset.wavelength.length; i++) {
    const w = dataset.wavelength[i]
    if (w < validRange[0] || w > validRange[1]) continue
    if (isMasked(w, masks)) continue
    out.push(i)
  }
  return out
}

function movingAverage(values: number[], half: number): number[] {
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j]
      count++
    }
    out[i] = sum / count
  }
  return out
}

function movingMedian(values: number[], half: number): number[] {
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) {
    out[i] = median(values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1)))
  }
  return out
}

export interface NoiseEstimate {
  sigma: number[]
  source: 'replicates' | 'second-difference'
  replicateCount: number
  median: number
}

/**
 * Per-channel noise scale. Replicates are the honest source; without them a
 * robust second-difference estimate is smoothed across channels. Smoothing
 * matters because a 3-replicate SD is itself very noisy.
 */
export function estimateNoise(sample: Sample, channelCount: number): NoiseEstimate {
  const reps = sample.replicates?.filter((r) => r.length === channelCount) ?? []
  let raw: number[]
  if (reps.length >= 2) {
    raw = new Array<number>(channelCount).fill(0)
    for (let i = 0; i < channelCount; i++) {
      const vals = reps.map((r) => r[i])
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1)
      raw[i] = Math.sqrt(Math.max(variance, 0))
    }
    const smooth = movingAverage(movingMedian(raw, 9), 5)
    const sigma = smooth.map((v) => Math.max(v, 5e-4))
    return {
      sigma,
      source: 'replicates',
      replicateCount: reps.length,
      median: median(sigma),
    }
  }
  raw = new Array<number>(channelCount).fill(0)
  const y = sample.values
  for (let i = 0; i < channelCount; i++) {
    const a = y[Math.max(0, i - 1)]
    const b = y[i]
    const c = y[Math.min(channelCount - 1, i + 1)]
    raw[i] = Math.abs(a - 2 * b + c) / Math.sqrt(6)
  }
  // 1.4826 turns the MAD of a normal into a sigma; the median filter kills
  // peaks (which would otherwise inflate the local estimate).
  const smooth = movingAverage(movingMedian(raw, 15), 7)
  const scaled = smooth.map((v) => v / 1.4826)
  const sigma = scaled.map((v) => Math.max(v, 5e-4))
  return {
    sigma,
    source: 'second-difference',
    replicateCount: 0,
    median: median(sigma),
  }
}

export interface Design {
  indices: number[]
  wavelength: number[]
  y: number[]
  sigma: number[]
  weights: number[]
  /** Weights used for identifiability: instrument noise, not the fit choice. */
  identWeights: number[]
  t: number[]
  references: ReferenceSpectrum[]
  refColumns: number[][]
  baselineColumns: number[][]
  degree: number
  degreeOfFreedom: number
  activeIds: string[]
  sample: Sample
  library: LibraryVersion
  config: FitConfig
  noiseSource: NoiseEstimate['source']
  noiseMedian: number
  coverage: Record<string, ComponentCoverage>
}

export function buildDesign(
  dataset: Dataset,
  sample: Sample,
  library: LibraryVersion,
  config: FitConfig,
): Design {
  const refs = config.activeReferenceIds
    .map((id) => library.references.find((r) => r.id === id))
    .filter((r): r is ReferenceSpectrum => Boolean(r))
  if (refs.length === 0) throw new Error('至少需要一个候选组分。')
  const indices = usableIndices(dataset, config.validRange, config.maskRanges)
  if (indices.length < MIN_POINTS) {
    throw new Error(`可用波长点只有 ${indices.length} 个，至少需要 ${MIN_POINTS} 个。请放宽有效区或减少屏蔽区。`)
  }
  const noise = estimateNoise(sample, dataset.wavelength.length)
  const y = indices.map((i) => sample.values[i])
  const weights = indices.map((i) => (config.weighting === 'noise' ? 1 / noise.sigma[i] ** 2 : 1))
  const identWeights = indices.map((i) => {
    const s = dataset.noiseTruth?.[i] ?? noise.sigma[i]
    return s > 0 ? 1 / (s * s) : 1
  })
  const center = (config.validRange[0] + config.validRange[1]) / 2
  const half = Math.max((config.validRange[1] - config.validRange[0]) / 2, 1e-9)
  const wavelength = indices.map((i) => dataset.wavelength[i])
  const t = wavelength.map((w) => Math.max(-1, Math.min(1, (w - center) / half)))
  const refColumns = refs.map((r) => indices.map((i) => r.values[i]))
  const baselineColumns = chebyshevBasis(t, config.baselineDegree)
  return {
    indices,
    wavelength,
    y,
    sigma: indices.map((i) => noise.sigma[i]),
    weights,
    identWeights,
    t,
    references: refs,
    refColumns,
    baselineColumns,
    degree: config.baselineDegree,
    degreeOfFreedom: refs.length + baselineColumns.length,
    activeIds: refs.map((r) => r.id),
    sample,
    library,
    config,
    noiseSource: noise.source,
    noiseMedian: median(indices.map((i) => noise.sigma[i])),
    coverage: componentCoverage(dataset, library, config),
  }
}

/** Weighted projection of reference columns off the baseline basis. */
export function residualiseAgainstBaseline(design: Design, weightOverride?: number[]): number[][] {
  const B = design.baselineColumns
  const p = B.length
  const w = weightOverride ?? design.identWeights
  const n = design.y.length
  const gram = zeros2(p, p)
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) {
      let s = 0
      for (let i = 0; i < n; i++) s += B[a][i] * B[b][i] * w[i]
      gram[a][b] = s + (a === b ? 1e-8 : 0)
    }
  }
  const residual: number[][] = []
  for (let k = 0; k < design.refColumns.length; k++) {
    const col = design.refColumns[k]
    const rhs = zeros(p)
    for (let a = 0; a < p; a++) {
      let s = 0
      for (let i = 0; i < n; i++) s += B[a][i] * col[i] * w[i]
      rhs[a] = s
    }
    const coef = solveLinear(gram, rhs)
    const out = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      let pred = 0
      if (coef) for (let a = 0; a < p; a++) pred += coef[a] * B[a][i]
      out[i] = col[i] - pred
    }
    residual.push(out)
  }
  return residual
}

function weightedNorm(col: number[], w: number[]): number {
  let s = 0
  for (let i = 0; i < col.length; i++) s += w[i] * col[i] * col[i]
  return Math.sqrt(s)
}

function weightedMean(col: number[], w: number[]): number {
  let s = 0
  let sw = 0
  for (let i = 0; i < col.length; i++) {
    s += w[i] * col[i]
    sw += w[i]
  }
  return sw > 0 ? s / sw : 0
}

/**
 * A masked peak means the reported concentration now comes from weak
 * shoulders only — any interval computed before the mask no longer applies,
 * and we refuse to quote a fresh one.
 */
export function componentCoverage(
  dataset: Dataset,
  library: LibraryVersion,
  config: FitConfig,
): Record<string, ComponentCoverage> {
  const refs = config.activeReferenceIds
    .map((id) => library.references.find((r) => r.id === id))
    .filter((r): r is ReferenceSpectrum => Boolean(r))
  const out: Record<string, ComponentCoverage> = {}
  const fullValid: number[] = []
  for (let i = 0; i < dataset.wavelength.length; i++) {
    const w = dataset.wavelength[i]
    if (w >= config.validRange[0] && w <= config.validRange[1]) fullValid.push(i)
  }
  const usable = new Set(usableIndices(dataset, config.validRange, config.maskRanges))
  for (const ref of refs) {
    let peakIdx = fullValid[0] ?? 0
    for (const i of fullValid) if (ref.values[i] > ref.values[peakIdx]) peakIdx = i
    const peakWavelength = dataset.wavelength[peakIdx]
    const peakMasked = !usable.has(peakIdx)
    let total = 0
    let kept = 0
    for (const i of fullValid) {
      total += ref.values[i] ** 2
      if (usable.has(i)) kept += ref.values[i] ** 2
    }
    const energyFraction = total > 0 ? kept / total : 0
    const reasons: string[] = []
    if (peakMasked) reasons.push(`主峰 ${peakWavelength.toFixed(0)} nm 已被屏蔽`)
    if (energyFraction < 0.45) reasons.push(`仅保留 ${(energyFraction * 100).toFixed(0)}% 的谱能量`)
    const intervalInvalid = peakMasked || energyFraction < 0.45
    out[ref.id] = {
      componentId: ref.id,
      peakWavelength,
      peakMasked,
      energyFraction,
      intervalInvalid,
      reason: reasons.length ? `${reasons.join('，')}；该组分的旧不确定范围已作废，屏蔽峰区下不给新区间。` : '',
    }
  }
  return out
}

function weightedMultipleR2(col: number[], baseline: number[][], w: number[]): number {
  const p = baseline.length
  const n = col.length
  const gram = zeros2(p, p)
  const rhs = zeros(p)
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) {
      let s = 0
      for (let i = 0; i < n; i++) s += baseline[a][i] * baseline[b][i] * w[i]
      gram[a][b] = s + (a === b ? 1e-8 : 0)
    }
    let s = 0
    for (let i = 0; i < n; i++) s += baseline[a][i] * col[i] * w[i]
    rhs[a] = s
  }
  const coef = solveLinear(gram, rhs)
  if (!coef) return 1
  let ssr = 0
  let sst = 0
  const mean = weightedMean(col, w)
  for (let i = 0; i < n; i++) {
    let pred = 0
    for (let a = 0; a < p; a++) pred += coef[a] * baseline[a][i]
    ssr += w[i] * (col[i] - pred) ** 2
    sst += w[i] * (col[i] - mean) ** 2
  }
  if (sst <= 1e-20) return 1
  return Math.max(0, Math.min(1, 1 - ssr / sst))
}

export function identifiability(design: Design, wavelengthsUsed: number): IdentifiabilityReport {
  const residual = residualiseAgainstBaseline(design)
  const k = residual.length
  const w = design.identWeights
  const n = design.y.length
  const norms = residual.map((col) => weightedNorm(col, w))
  const normalized = residual.map((col, i) => col.map((v) => (norms[i] > 1e-12 ? v / norms[i] : 0)))

  const gram = zeros2(k, k)
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0
      for (let r = 0; r < n; r++) s += w[r] * normalized[i][r] * normalized[j][r]
      gram[i][j] = s
      gram[j][i] = s
    }
  }
  const corr = gram.map((row) => [...row])

  const { values } = symmetricEigen(gram)
  const maxEig = values[values.length - 1] ?? 0
  const positive = values.filter((v) => v > Math.max(maxEig, 0) * 1e-12)
  const condition = positive.length ? Math.sqrt(maxEig / positive[0]) : Number.POSITIVE_INFINITY
  const effectiveRank = effectiveRankFromGram(gram, 1e-10)

  const parent = Array.from({ length: k }, (_, i) => i)
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const next = parent[x]
      parent[x] = r
      x = next
    }
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const r = corr[i][j]
      // Condition number of the 2x2 normalised Gram block.
      const disc = Math.max(1e-18, 1 - r * r)
      const pairCondition = r >= 0 ? Math.sqrt((1 + r) / disc) : 1
      if (Math.abs(r) >= IDENT_CORR_THRESHOLD || pairCondition >= IDENT_CONDITION_THRESHOLD) {
        union(i, j)
      }
    }
  }

  const buckets = new Map<number, number[]>()
  for (let i = 0; i < k; i++) {
    const root = find(i)
    const list = buckets.get(root) ?? []
    list.push(i)
    buckets.set(root, list)
  }

  const groups: IdentifiableGroup[] = []
  for (const members of buckets.values()) {
    const memberIds = members.map((m) => design.activeIds[m])
    let maxCorr = 0
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        maxCorr = Math.max(maxCorr, Math.abs(corr[members[a]][members[b]]))
      }
    }
    const subGram = members.map((a) => members.map((b) => gram[a][b]))
    const subEigen = symmetricEigen(subGram)
    const subMax = subEigen.values[subEigen.values.length - 1] ?? 0
    const subMin = subEigen.values[0] ?? 0
    const subCond = members.length > 1 ? Math.sqrt(Math.max(subMax, 1e-18) / Math.max(subMin, 1e-18)) : 1
    const absorbed =
      members.length === 1 &&
      weightedMultipleR2(design.refColumns[members[0]], design.baselineColumns, w) >= BASELINE_ABSORB_R2
    groups.push({
      id: `G${groups.length + 1}`,
      memberIds,
      maxCorr,
      condition: subCond,
      merged: members.length > 1,
      baselineAbsorbed: absorbed,
    })
  }
  const firstIndex = (g: IdentifiableGroup) => design.activeIds.indexOf(g.memberIds[0])
  groups.sort((a, b) => firstIndex(a) - firstIndex(b))

  return {
    libraryId: design.library.id,
    referenceIds: [...design.activeIds],
    groups,
    correlation: corr,
    condition,
    effectiveRank,
    threshold: IDENT_CORR_THRESHOLD,
    baselineDegree: design.degree,
    wavelengthsUsed,
    note: buildIdentNote(groups, condition),
  }
}

function buildIdentNote(groups: IdentifiableGroup[], condition: number): string {
  const merged = groups.filter((g) => g.merged)
  const absorbed = groups.filter((g) => g.baselineAbsorbed)
  const parts: string[] = []
  if (merged.length) {
    parts.push(
      `${merged
        .map((g) => `${g.memberIds.join(' + ')}（|r|≤${g.maxCorr.toFixed(4)}，κ≈${g.condition.toFixed(1)}）`)
        .join('；')} 在扣除基线后的方向几乎相同，只能可靠估计合计，不能给出各自的精确数值。`,
    )
  } else {
    parts.push('当前候选集内没有必须合并的组分。')
  }
  if (absorbed.length) {
    parts.push(
      `${absorbed.map((g) => g.memberIds.join(' + ')).join('；')} 的谱形能被基线基函数几乎完全复制，单项含量不可靠。`,
    )
  }
  parts.push(
    `整体条件数 ${Number.isFinite(condition) ? condition.toFixed(1) : '∞'}（合并阈值 ${IDENT_CONDITION_THRESHOLD}，相关阈值 ${IDENT_CORR_THRESHOLD}）。`,
  )
  return parts.join(' ')
}

export function groupTruth(sampleTruth: Record<string, number> | undefined, ids: string[]): number {
  if (!sampleTruth) return 0
  return ids.reduce((s, id) => s + (sampleTruth[id] ?? 0), 0)
}

export function matrixInverse(gram: number[][], ridge = 1e-9): number[][] | null {
  const scale = Math.max(1, ...gram.map((row, i) => Math.abs(row[i])))
  const mat = gram.map((row, i) => {
    const r = [...row]
    r[i] += ridge * scale
    return r
  })
  return invertMatrix(mat)
}
