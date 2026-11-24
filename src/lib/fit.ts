import type {
  BadPoint,
  ConcentrationInterval,
  DesignSummary,
  FitSnapshot,
  FitMode,
  GroupEstimate,
  IdentifiableGroup,
  UnexplainedBand,
} from './types'
import type { Design } from './design'
import { baselineLevelMax } from './baseline'
import { identifiability, matrixInverse } from './design'
import { solveLinear, zeros, zeros2 } from './linalg'

export interface SolveOptions {
  baselineBound: number
  lambdaBase: number
  lambdaL1: number
  mode: FitMode
  /** Baseline DC coefficient forced to zero; used to expose drift aliasing. */
  strictBaseline?: boolean
  /** Groups the caller wants merged regardless of the report. */
  forcedMerge?: string[][]
  quoteIntervals?: boolean
}

export interface SolveResult {
  concentrations: Record<string, number>
  groupValues: Record<string, number>
  baseline: number[]
  fitted: number[]
  residual: number[]
  contributions: Record<string, number[]>
  groupContributions: Record<string, number[]>
  condition: number
  chi2Reduced: number
  unexplainedRms: number
  noiseRms: number
  ssResidual: number
  ssTotal: number
  rSquared: number
  bounds: number
  converged: boolean
  iterations: number
  groupEstimates: GroupEstimate[]
  intervals: Record<string, ConcentrationInterval>
  groups: IdentifiableGroup[]
  bands: UnexplainedBand[]
  badPoints: BadPoint[]
  notes: string[]
  lambdaBase: number
  lambdaL1: number
  /** Free concentration directions after merging: groups, not components. */
  freeDirections: number
  coverage: Record<string, import('./types').ComponentCoverage>
}

interface EffectiveDesign {
  /** Columns: one per identifiable group, then the baseline basis. */
  columns: number[][]
  groupMembers: number[][]
  kEff: number
  p: number
  A: number[][]
  rhs: number[]
}

/**
 * Merged groups are handled by building an *effective* column per group
 * (the sum of its members) rather than by algebraic row elimination, which
 * would leave the removed coordinates to drift. This is the honest model:
 * the data only constrain the sum, so the sum is the parameter.
 */
function effectiveDesign(design: Design, merge: number[][]): EffectiveDesign {
  const mergeOf = new Map<number, number[]>()
  const merged = new Set<number>()
  merge.forEach((group) => {
    const lead = group[0]
    mergeOf.set(lead, group)
    group.forEach((i) => {
      if (i !== lead) merged.add(i)
    })
  })
  const groupMembers: number[][] = []
  const baseColumns: number[][] = []
  for (let i = 0; i < design.refColumns.length; i++) {
    if (merged.has(i)) continue
    const members = mergeOf.get(i)
    if (members) {
      groupMembers.push(members)
      // The fraction of the total each member carries is not identified; use
      // the mean profile as the group direction so the fitted coefficient *is*
      // the group total, not a sum-weighted compromise.
      const col = new Array<number>(design.y.length).fill(0)
      for (const m of members) for (let r = 0; r < col.length; r++) col[r] += design.refColumns[m][r] / members.length
      baseColumns.push(col)
    } else {
      groupMembers.push([i])
      baseColumns.push(design.refColumns[i])
    }
  }
  const kEff = baseColumns.length
  const p = design.baselineColumns.length
  const n = design.y.length
  const w = design.weights
  const columns = [...baseColumns, ...design.baselineColumns]
  const nVar = kEff + p
  const A = zeros2(nVar, nVar)
  const rhs = zeros(nVar)
  for (let i = 0; i < nVar; i++) {
    const ci = columns[i]
    let bi = 0
    for (let r = 0; r < n; r++) bi += ci[r] * design.y[r] * w[r]
    rhs[i] = bi
    for (let j = i; j < nVar; j++) {
      const cj = columns[j]
      let s = 0
      for (let r = 0; r < n; r++) s += ci[r] * cj[r] * w[r]
      A[i][j] = s
      A[j][i] = s
    }
  }
  return { columns, groupMembers, kEff, p, A, rhs }
}

/**
 * Joint box-constrained quadratic solve (active set).
 *
 * Minimise ½ zᵀGz − bᵀz over z = [concentrations; baseline coefficients]
 * subject to c_j ≥ 0 and |β_a| ≤ baselineBound. Alternating between the two
 * blocks converges only as fast as they are distinguishable — exactly the
 * situation this app warns about (a broad component vs. a smooth baseline),
 * so the blocks are solved *together*. The system is ≤ 16 variables wide, so a
 * dense solve per active-set pass is cheap.
 */
function solveBoxQP(
  G: number[][],
  b: number[],
  kConc: number,
  baselineBound: number,
  strictBaseline: boolean,
): { z: number[]; converged: boolean; iterations: number; boundHit: boolean } {
  const n = G.length
  const lower = new Array<number>(n).fill(0)
  const upper = new Array<number>(n).fill(Number.POSITIVE_INFINITY)
  for (let a = kConc; a < n; a++) {
    lower[a] = -baselineBound
    upper[a] = baselineBound
  }
  if (strictBaseline && n > kConc) {
    lower[kConc] = 0
    upper[kConc] = 0
  }
  const z = new Array<number>(n).fill(0)
  const state = new Array<number>(n).fill(0) // 0 free, 1 lower, 2 upper
  let converged = false
  let iterations = 0
  const scale = Math.max(1, ...G.map((row, i) => Math.abs(row[i])))
  const gradTol = 1e-10 * scale
  const boundTol = 1e-12 * Math.max(1, baselineBound)

  for (let iter = 0; iter < 200; iter++) {
    iterations = iter + 1
    const free: number[] = []
    for (let i = 0; i < n; i++) if (state[i] === 0) free.push(i)
    if (free.length > 0) {
      const sub = free.map((i) => free.map((j) => G[i][j]))
      const rhs = free.map((i) => {
        let v = b[i]
        for (let j = 0; j < n; j++) if (state[j] !== 0) v -= G[i][j] * z[j]
        return v
      })
      const sol = solveLinear(sub, rhs)
      if (!sol) {
        // A genuinely flat free direction (e.g. a component absorbed by the
        // baseline). Pin it at its lower bound and carry on; the baseline
        // absorption warning is raised elsewhere.
        state[free[free.length - 1]] = 1
        z[free[free.length - 1]] = lower[free[free.length - 1]]
        continue
      }
      free.forEach((i, t) => (z[i] = sol[t]))
    }
    let clamped = false
    for (const i of free) {
      if (z[i] < lower[i] - boundTol) {
        z[i] = lower[i]
        state[i] = 1
        clamped = true
      } else if (z[i] > upper[i] + boundTol) {
        z[i] = upper[i]
        state[i] = 2
        clamped = true
      }
    }
    if (clamped) continue
    // KKT check: a variable pinned at a bound must not want to move inward.
    let release = -1
    let worst = 0
    for (let i = 0; i < n; i++) {
      if (state[i] === 0) continue
      let g = -b[i]
      for (let j = 0; j < n; j++) g += G[i][j] * z[j]
      if (state[i] === 1 && g < -gradTol && -g > worst) {
        worst = -g
        release = i
      } else if (state[i] === 2 && g > gradTol && g > worst) {
        worst = g
        release = i
      }
    }
    if (release < 0) {
      converged = true
      break
    }
    state[release] = 0
  }

  let boundHit = false
  for (let a = kConc; a < n; a++) {
    if (baselineBound > 0 && Math.abs(z[a]) >= baselineBound * (1 - 1e-9)) boundHit = true
  }
  return { z, converged, iterations, boundHit }
}

/**
 * Solve for concentrations and baseline coefficients jointly. The L1 term is
 * applied as a relative ridge on each reference column's own diagonal, so λ is
 * invariant to the weighting choice.
 */
function fitConstrained(
  design: Design,
  eff: EffectiveDesign,
  opts: {
    lambdaBase: number
    lambdaL1: number
    baselineBound: number
    strictBaseline?: boolean
  },
): { c: number[]; beta: number[]; converged: boolean; iterations: number; boundHit: boolean } {
  const n = design.y.length
  const p = eff.p
  const k = eff.kEff
  const w = design.weights
  const B = design.baselineColumns
  const cols = eff.columns
  const nVar = k + p
  const sqrtW = w.map((v) => Math.sqrt(v))
  const X: number[][] = cols.map((col) => col.map((v, r) => v * sqrtW[r]))
  X.push(...B.map((col) => col.map((v, r) => v * sqrtW[r])))
  const yw = design.y.map((v, r) => v * sqrtW[r])

  const G = zeros2(nVar, nVar)
  const b = zeros(nVar)
  for (let i = 0; i < nVar; i++) {
    let s = 0
    for (let r = 0; r < n; r++) s += X[i][r] * yw[r]
    b[i] = s
    for (let j = i; j < nVar; j++) {
      let t = 0
      for (let r = 0; r < n; r++) t += X[i][r] * X[j][r]
      G[i][j] = t
      G[j][i] = t
    }
    if (i >= k) G[i][i] = G[i][i] * (1 + Math.max(0, opts.lambdaBase)) + 1e-10 * Math.max(1, G[i][i])
  }
  // L1 on non-negative concentrations is a soft threshold on the gradient:
  //   min ½cᵀGc − bᵀc + λ Σ c_j  ⇒  b_j ← b_j − λ·‖x_j‖_W.
  // Normalising by the column's own weighted norm makes λ invariant to the
  // weighting scheme and to the reference's peak height.
  if (opts.lambdaL1 > 0) {
    // λ is expressed relative to the *scale of the concentrations themselves*:
    // take the unconstrained least-squares coefficients c_j = b_j/G_jj, use
    // their median as a reference level, and soft-threshold each normal
    // equation at λ times that level. λ = 0.5 therefore discards directions
    // whose evidence is below half the typical component's. This makes λ
    // dimensionless and independent of both the weighting and peak heights.
    // λ is a fraction of the *typical positive* evidence: λ = 0.1 shrinks
    // directions whose normal-equation evidence is below 10% of the median
    // positive LS coefficient. Kept as a fraction so it is dimensionless.
    const ls = new Array<number>(k)
    for (let j = 0; j < k; j++) ls[j] = b[j] / Math.max(G[j][j], 1e-30)
    const positive = ls.filter((v) => v > 0).sort((a, b2) => a - b2)
    const ref = positive.length ? positive[Math.floor(positive.length / 2)] : 0
    for (let j = 0; j < k; j++) {
      b[j] -= Math.max(0, opts.lambdaL1) * 0.1 * G[j][j] * ref
    }
  }
  const { z, converged, iterations, boundHit } = solveBoxQP(
    G,
    b,
    k,
    opts.baselineBound,
    Boolean(opts.strictBaseline),
  )
  return { c: z.slice(0, k), beta: z.slice(k), converged, iterations, boundHit }
}

/**
 * Isolated outliers, not model error. A contaminant line or an unmodelled
 * component lights up a *run* of channels; calling each of those a "bad point"
 * (UN-01 produced 74 of them) buries the two real spikes and misdescribes a
 * physical signal as an instrument glitch.
 *
 * A point qualifies when the residual jumps away from the straight line through
 * its neighbours two channels either side:
 *
 *   d = r[i] − (r[i−2] + r[i+2]) / 2
 *
 * A smooth band — even on its steep flank — changes slowly over four channels,
 * so d stays near zero; a single-channel spike does not. Requiring |d| > 5σ_d
 * (σ_d = √1.5 · σ_i for independent channels) and |d| > 3 × noise RMS keeps the
 * test noise-aware. A genuine spike bleeds into its immediate neighbours, so
 * hits within 2 nm are merged and the strongest channel is reported.
 */
function detectBadPoints(design: Design, residual: number[], noiseRms: number): BadPoint[] {
  const n = residual.length
  const candidates: BadPoint[] = []
  for (let r = 2; r < n - 2; r++) {
    const d = residual[r] - 0.5 * (residual[r - 2] + residual[r + 2])
    const z = d / Math.max(design.sigma[r] * Math.sqrt(1.5), 1e-9)
    if (Math.abs(z) <= 5 || Math.abs(d) <= 3 * noiseRms) continue
    candidates.push({ index: design.indices[r], wavelength: design.wavelength[r], residual: residual[r], z })
  }
  // Report one point per physical spike.
  const found: BadPoint[] = []
  for (const c of candidates) {
    const last = found[found.length - 1]
    if (last && Math.abs(c.wavelength - last.wavelength) <= 2) {
      if (Math.abs(c.z) > Math.abs(last.z)) found[found.length - 1] = c
      continue
    }
    found.push(c)
  }
  found.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
  return found
}

function detectBands(design: Design, residual: number[], threshold: number): UnexplainedBand[] {
  const bands: UnexplainedBand[] = []
  const spacing = design.wavelength.length > 1 ? Math.abs(design.wavelength[1] - design.wavelength[0]) : 1
  let current: number[] = []
  const flush = () => {
    if (current.length >= 4) {
      let peakIdx = current[0]
      for (const idx of current) if (Math.abs(residual[idx]) > Math.abs(residual[peakIdx])) peakIdx = idx
      bands.push({
        from: design.wavelength[current[0]],
        to: design.wavelength[current[current.length - 1]],
        peakWavelength: design.wavelength[peakIdx],
        peakResidual: residual[peakIdx],
        integrated: current.reduce((s, idx) => s + residual[idx], 0) * spacing,
      })
    }
    current = []
  }
  for (let i = 0; i < residual.length; i++) {
    if (Math.abs(residual[i]) > threshold) current.push(i)
    else flush()
  }
  flush()
  bands.sort((a, b) => Math.abs(b.peakResidual) - Math.abs(a.peakResidual))
  return bands.slice(0, 8)
}

export function solve(design: Design, opts: SolveOptions): SolveResult {
  const p = design.baselineColumns.length
  const mode = opts.mode
  const baselineBound = opts.baselineBound
  const lambdaBase = opts.lambdaBase
  const lambdaL1 = mode === 'sparse' ? Math.max(0, opts.lambdaL1) : 0
  const notes: string[] = []

  const report = identifiability(design, design.indices.length)
  const requested = opts.forcedMerge ?? report.groups.filter((g) => g.merged).map((g) => g.memberIds)
  const mergeIdx = requested
    .map((ids) => ids.map((id) => design.activeIds.indexOf(id)).filter((i) => i >= 0))
    .filter((g) => g.length > 1)

  const eff = effectiveDesign(design, mergeIdx)
  // A strict (DC-free) baseline is an *additional* constraint, handled by a
  // fixed-point alternation: solve, project out the DC, re-solve.
  const { c: theta, beta, converged, iterations, boundHit } = fitConstrained(design, eff, {
    lambdaBase,
    lambdaL1,
    baselineBound,
    strictBaseline: opts.strictBaseline,
  })
  void baselineLevelMax

  // Spread each group's solved total back onto its members for display. When a
  // group is merged the split is *not* identified, so we report the total only
  // and mark members as merged; for a singleton there is nothing to split.
  const groupValues: Record<string, number> = {}
  const concentrations: Record<string, number> = {}
  for (const id of design.activeIds) concentrations[id] = 0
  const groupOf = new Map<number, number>()
  eff.groupMembers.forEach((members, g) => members.forEach((m) => groupOf.set(m, g)))
  const memberIndex = new Map<string, number>()
  design.activeIds.forEach((id, i) => memberIndex.set(id, i))
  const groupContributions: Record<string, number[]> = {}
  const contributions: Record<string, number[]> = {}
  for (const id of design.activeIds) contributions[id] = new Array<number>(design.y.length).fill(0)

  eff.groupMembers.forEach((members, g) => {
    const value = Math.max(0, theta[g])
    const ids = members.map((m) => design.activeIds[m])
    let groupId = ''
    const matched = report.groups.find((rg) => rg.memberIds.length === ids.length && rg.memberIds.every((id) => ids.includes(id)))
    groupId = matched?.id ?? `G${g + 1}`
    groupValues[groupId] = value
    const rows = new Array<number>(design.y.length).fill(0)
    for (const m of members) {
      for (let r = 0; r < rows.length; r++) rows[r] += design.refColumns[m][r] / members.length
    }
    for (let r = 0; r < rows.length; r++) rows[r] *= value
    groupContributions[groupId] = rows
    for (const id of ids) contributions[id] = new Array<number>(design.y.length).fill(0)
    // Keep the *total* attached to the first member so single-value tooltips
    // show something honest; merged status is carried by the interval map.
    const first = ids[0]
    for (let r = 0; r < rows.length; r++) contributions[first][r] = rows[r]
    concentrations[first] = value
  })
  void groupOf
  void memberIndex

  const baseline = new Array<number>(design.y.length).fill(0)
  for (let r = 0; r < design.y.length; r++) {
    let s = 0
    for (let j = 0; j < p; j++) s += beta[j] * design.baselineColumns[j][r]
    baseline[r] = s
  }
  const fitted = design.y.map((_, r) => {
    let s = baseline[r]
    for (const rows of Object.values(groupContributions)) s += rows[r]
    return s
  })
  const residual = design.y.map((v, r) => v - fitted[r])

  const ssResidual = residual.reduce((s, r) => s + r * r, 0)
  const yMean = design.y.reduce((s, v) => s + v, 0) / Math.max(1, design.y.length)
  const ssTotal = design.y.reduce((s, v) => s + (v - yMean) ** 2, 0)
  const nFree = eff.kEff + p
  const dof = Math.max(1, design.y.length - nFree)
  const chi2 = residual.reduce((s, r, i) => s + (r * r) / Math.max(design.sigma[i] ** 2, 1e-18), 0)
  const chi2Reduced = chi2 / dof
  const unexplainedRms = Math.sqrt(ssResidual / Math.max(1, residual.length))
  const noiseRms = Math.sqrt(design.sigma.reduce((s, v) => s + v * v, 0) / Math.max(1, design.sigma.length))
  const rSquared = ssTotal > 1e-20 ? 1 - ssResidual / ssTotal : 0

  const bands = detectBands(design, residual, Math.max(3.2 * noiseRms, 0.02))
  const badPoints = detectBadPoints(design, residual, noiseRms)

  // Covariance of the effective parameters. Only the group totals exist, so
  // only group totals get intervals — never a per-member number in a merged
  // group.
  const inv = opts.quoteIntervals === false ? null : matrixInverse(eff.A)
  const scale = Math.max(chi2Reduced, 1)
  const intervals: Record<string, ConcentrationInterval> = {}
  const groupEstimates: GroupEstimate[] = []
  const coverage = design.coverage

  eff.groupMembers.forEach((members, g) => {
    const ids = members.map((m) => design.activeIds[m])
    const value = Math.max(0, theta[g])
    let groupId = ''
    const matched = report.groups.find((rg) => rg.memberIds.length === ids.length && rg.memberIds.every((id) => ids.includes(id)))
    groupId = matched?.id ?? `G${g + 1}`
    const blocked = ids.some((id) => coverage[id]?.intervalInvalid)
    let ci: number | null = null
    if (inv && !blocked && inv[g][g] > 0) ci = 1.96 * Math.sqrt(inv[g][g] * scale)
    const merged = ids.length > 1
    groupEstimates.push({ groupId, memberIds: ids, value, ci95: ci, merged })
    if (merged) {
      for (const id of ids) {
        intervals[id] = {
          componentId: id,
          value: 0,
          ci95: null,
          status: blocked ? 'masked' : 'merged',
        }
      }
    } else {
      const id = ids[0]
      const cov = coverage[id]
      let status: ConcentrationInterval['status'] = 'identified'
      let interval = ci
      if (cov?.intervalInvalid) {
        status = 'masked'
        interval = null
      } else if (report.groups.find((rg) => rg.memberIds[0] === id)?.baselineAbsorbed) {
        status = 'baseline'
        interval = null
      } else if (value <= 0) {
        status = 'undetected'
        interval = null
      }
      intervals[id] = { componentId: id, value, ci95: interval, status }
    }
  })
  // Identifiability groups that the caller did not merge still need an entry for
  // display, keyed by the report's own ids.
  for (const rg of report.groups) {
    if (groupEstimates.some((g) => g.memberIds.join(',') === rg.memberIds.join(','))) continue
    const value = rg.memberIds.reduce((s, id) => s + (concentrations[id] ?? 0), 0)
    groupEstimates.push({ groupId: rg.id, memberIds: rg.memberIds, value, ci95: null, merged: rg.merged })
  }

  if (eff.kEff < design.activeIds.length) {
    const mergedLabels = eff.groupMembers
      .filter((m) => m.length > 1)
      .map((m) => m.map((i) => design.activeIds[i]).join(' + '))
    notes.push(`${mergedLabels.join('、')} 被合并为一个自由度；只报告合计值，不提供各成员的独立数值或区间。`)
  }
  const masked = Object.values(coverage).filter((c) => c.intervalInvalid)
  if (masked.length) {
    notes.push(`${masked.map((m) => m.componentId).join('、')} 的主峰区被屏蔽，旧不确定范围作废，本次不给区间。`)
  }
  if (mode === 'sparse' && lambdaL1 > 0) {
    notes.push(`稀疏拟合：L1 正则 λ₁ = ${formatLambda(lambdaL1)}；恰为 0 的方向按“未检出”解释，不强行给非零值。`)
  }
  if (opts.strictBaseline) notes.push('基线被强制为无直流偏移，用于漂移可辨识性核对。')
  if (boundHit) notes.push(`基线系数触及 ±${baselineBound} 的上界；基线形状受约束裁剪，残差可能因此偏大。`)
  if (!converged) notes.push(`坐标下降在 ${iterations} 次扫描后仍未收敛；数值保留但需谨慎。`)
  if (noiseRms > 0 && unexplainedRms > 4 * noiseRms) {
    notes.push(`残差 RMS 是噪声水平的 ${(unexplainedRms / noiseRms).toFixed(1)} 倍，存在模型外信号（见未解释峰区）。`)
  }

  return {
    concentrations,
    groupValues,
    baseline,
    fitted,
    residual,
    contributions,
    groupContributions,
    condition: report.condition,
    chi2Reduced,
    unexplainedRms,
    noiseRms,
    ssResidual,
    ssTotal,
    rSquared,
    bounds: baselineBound,
    converged,
    iterations,
    groupEstimates,
    intervals,
    groups: report.groups,
    bands,
    badPoints,
    notes,
    lambdaBase,
    lambdaL1,
    freeDirections: eff.kEff,
    coverage,
  }
}

function formatLambda(v: number): string {
  if (v === 0) return '0'
  if (v >= 1 || v < 0.001) return v.toPrecision(3)
  return v.toFixed(4)
}

export interface SnapshotMeta {
  datasetTitle: string
  referenceNames: Record<string, string>
  referenceSlots: Record<string, number>
  libraryVersion: string
  libraryLabel: string
  validRange: [number, number]
  maskRanges: { from: number; to: number }[]
  signatureExtras?: Record<string, unknown>
}

export function snapshotSignature(design: Design, extras?: Record<string, unknown>): string {
  const config = design.config
  return JSON.stringify({
    dataset: design.sample.id,
    library: design.library.id,
    active: design.activeIds,
    validRange: config.validRange,
    masks: [...config.maskRanges]
      .map((m) => ({ from: m.from, to: m.to }))
      .sort((a, b) => a.from - b.from),
    mode: config.mode,
    weighting: config.weighting,
    degree: config.baselineDegree,
    // The signature describes the *configuration* that produced the fit, so it
    // records the requested λ values. The snapshot's own lambdaL1 may be
    // zeroed in weighted mode, which must not make a quote look stale.
    lambdaBase: config.lambdaBase,
    lambdaL1: config.lambdaL1,
    bound: config.baselineBound,
    ...extras,
  })
}

export function buildSnapshot(design: Design, result: SolveResult, meta: SnapshotMeta): FitSnapshot {
  const config = design.config
  const sample = design.sample
  const referenceNames: Record<string, string> = {}
  const referenceSlots: Record<string, number> = {}
  for (const id of design.activeIds) {
    referenceNames[id] = meta.referenceNames[id] ?? id
    referenceSlots[id] = meta.referenceSlots[id] ?? 1
  }
  return {
    id: `${sample.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    sampleId: sample.id,
    sampleName: sample.name,
    sampleKind: sample.kind,
    datasetTitle: meta.datasetTitle,
    signature: snapshotSignature(design, meta.signatureExtras),
    wavelength: design.wavelength,
    sampleValues: design.y,
    sampleNote: sample.note,
    libraryId: design.library.id,
    libraryVersion: meta.libraryVersion,
    libraryLabel: meta.libraryLabel,
    activeReferenceIds: design.activeIds,
    referenceNames,
    referenceSlots,
    mode: config.mode,
    weighting: config.weighting,
    maskRanges: meta.maskRanges.map((m) => ({ from: m.from, to: m.to })),
    validRange: meta.validRange,
    baselineDegree: config.baselineDegree,
    baselineBound: result.bounds,
    lambdaBase: result.lambdaBase,
    lambdaL1: result.lambdaL1,
    concentrations: result.concentrations,
    intervals: result.intervals,
    groups: result.groups,
    groupEstimates: result.groupEstimates,
    groupContributions: result.groupContributions,
    baseline: result.baseline,
    fitted: result.fitted,
    residual: result.residual,
    contributions: result.contributions,
    condition: result.condition,
    chi2Reduced: result.chi2Reduced,
    unexplainedRms: result.unexplainedRms,
    noiseRms: result.noiseRms,
    unexplainedFraction: result.unexplainedRms / Math.max(result.noiseRms, 1e-9),
    bands: result.bands,
    badPoints: result.badPoints,
    effectiveCount: design.indices.length,
    notes: result.notes,
    coverage: result.coverage ?? design.coverage,
    ssTotal: result.ssTotal,
    ssResidual: result.ssResidual,
  }
}

export function designSummary(design: Design): DesignSummary {
  return {
    points: design.indices.length,
    channels: design.y.length,
    parameters: design.degreeOfFreedom,
    dof: Math.max(1, design.y.length - design.degreeOfFreedom),
    noiseMedian: design.noiseMedian,
    noiseSource: design.noiseSource,
  }
}

export { chunkMedian } from './stats'
export { median } from './linalg'
