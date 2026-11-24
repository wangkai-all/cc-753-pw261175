import type {
  CalibrationPoint,
  ComponentCoverage,
  Dataset,
  FitConfig,
  FitMode,
  FitSnapshot,
  GroupEstimate,
  LibraryVersion,
  MaskRange,
  SelectionMetric,
  TuningConfig,
  TuningResult,
  Weighting,
} from './types'
import { buildDesign, groupTruth, identifiability } from './design'
import { buildSnapshot, solve } from './fit'

export interface TuningInput {
  dataset: Dataset
  library: LibraryVersion
  base: Omit<FitConfig, 'sampleId' | 'lambdaBase' | 'lambdaL1'>
  fallbackLambdaBase: number
  fallbackLambdaL1: number
  sampleIds: string[]
  metric: SelectionMetric
  candidateBase: number[]
  candidateL1: number[]
  mode: FitMode
  baselineBound: number
}

function aggregateErrors(
  groups: GroupEstimate[],
  truth: Record<string, number> | undefined,
): { rms: number; max: number } {
  if (!truth) return { rms: 0, max: 0 }
  let ss = 0
  let max = 0
  let count = 0
  for (const g of groups) {
    const t = groupTruth(truth, g.memberIds)
    // Only components that are actually present carry signal for selection;
    // a zero-truth component's absolute error is still informative though.
    const err = g.value - t
    ss += err * err
    max = Math.max(max, Math.abs(err))
    count++
  }
  return { rms: count ? Math.sqrt(ss / count) : 0, max }
}

function predictiveScore(
  design: ReturnType<typeof buildDesign>,
  result: ReturnType<typeof solve>,
  metric: SelectionMetric,
  truth: Record<string, number> | undefined,
): number {
  if (metric === 'group-rms') {
    return aggregateErrors(result.groupEstimates, truth).rms
  }
  // Predictive RMS is evaluated on the same wavelengths but with the
  // *held-out* sample: the residual already is out-of-sample with respect to
  // the model (the sample is never used to build the reference library).
  let ss = 0
  for (let i = 0; i < result.residual.length; i++) ss += result.residual[i] ** 2 / Math.max(design.sigma[i] ** 2, 1e-18)
  return Math.sqrt(ss / Math.max(1, result.residual.length))
}

export function tune(input: TuningInput): TuningResult {
  const notes: string[] = []
  const usedSampleIds = input.sampleIds.filter((id) => input.dataset.samples.some((s) => s.id === id))
  if (usedSampleIds.length === 0) {
    return {
      mode: input.mode,
      weighting: input.base.weighting,
      lambdaBase: input.fallbackLambdaBase,
      lambdaL1: input.fallbackLambdaL1,
      basePath: [],
      l1Path: [],
      usedSampleIds: [],
      metric: input.metric,
      sampleCount: 0,
      note: '没有选中的独立标定样本，无法挑选正则参数。请至少勾选一个标定样。',
      feasible: false,
      bestBase: null,
      bestL1: null,
    }
  }

  const solutions = new Map<string, { design: ReturnType<typeof buildDesign>; result: ReturnType<typeof solve> }>()
  const solveCell = (
    sampleId: string,
    lambdaBase: number,
    lambdaL1: number,
  ): { design: ReturnType<typeof buildDesign>; result: ReturnType<typeof solve> } | null => {
    const key = `${sampleId}|${lambdaBase}|${lambdaL1}`
    const cached = solutions.get(key)
    if (cached) return cached
    const sample = input.dataset.samples.find((s) => s.id === sampleId)
    if (!sample) return null
    try {
      const design = buildDesign(input.dataset, sample, input.library, {
        ...input.base,
        sampleId,
        lambdaBase,
        lambdaL1,
        mode: input.mode,
      })
      const result = solve(design, {
        baselineBound: input.baselineBound,
        lambdaBase,
        lambdaL1,
        mode: input.mode,
        quoteIntervals: false,
      })
      const entry = { design, result }
      solutions.set(key, entry)
      return entry
    } catch {
      return null
    }
  }

  const basePath: CalibrationPoint[] = []
  let bestBase: { lambda: number; score: number } | null = null
  for (const lambda of input.candidateBase) {
    let scoreSum = 0
    let count = 0
    const perSample: CalibrationPoint['perSample'] = []
    for (const sampleId of usedSampleIds) {
      const sample = input.dataset.samples.find((s) => s.id === sampleId)!
      const cell = solveCell(sampleId, lambda, input.mode === 'sparse' ? 0 : 0)
      if (!cell) continue
      const score = predictiveScore(cell.design, cell.result, input.metric, sample.truth)
      scoreSum += score
      count++
      const estimate: Record<string, number> = {}
      for (const g of cell.result.groupEstimates) for (const id of g.memberIds) estimate[id] = cell.result.concentrations[id]
      perSample.push({ sampleId, score, truth: sample.truth ?? {}, estimate })
    }
    if (!count) continue
    const mean = scoreSum / count
    basePath.push({ lambda, score: mean, predictiveRms: mean, activeCount: 0, perSample })
    if (!bestBase || mean < bestBase.score) bestBase = { lambda, score: mean }
  }

  const l1Path: CalibrationPoint[] = []
  let bestL1: { lambda: number; score: number } | null = null
  for (const lambda of input.candidateL1) {
    let scoreSum = 0
    let activeSum = 0
    let count = 0
    const perSample: CalibrationPoint['perSample'] = []
    if (input.mode !== 'sparse') {
      break
    }
    for (const sampleId of usedSampleIds) {
      const sample = input.dataset.samples.find((s) => s.id === sampleId)!
      const cell = solveCell(sampleId, bestBase?.lambda ?? input.fallbackLambdaBase, lambda)
      if (!cell) continue
      const score = predictiveScore(cell.design, cell.result, input.metric, sample.truth)
      scoreSum += score
      count++
      activeSum += cell.result.groupEstimates.filter((g) => Math.abs(g.value) > 1e-6).length
      const estimate: Record<string, number> = {}
      for (const g of cell.result.groupEstimates) for (const id of g.memberIds) estimate[id] = cell.result.concentrations[id]
      perSample.push({ sampleId, score, truth: sample.truth ?? {}, estimate })
    }
    if (!count) continue
    const mean = scoreSum / count
    l1Path.push({ lambda, score: mean, predictiveRms: mean, activeCount: activeSum / count, perSample })
    // One-standard-error style rule: among near-tied scores prefer sparser.
    const tol = 0.02
    if (!bestL1 || mean < bestL1.score * (1 - tol) || (mean <= bestL1.score * (1 + tol) && lambda > bestL1.lambda)) {
      bestL1 = { lambda, score: mean }
    }
  }

  if (basePath.length === 0) notes.push('基线正则的所有候选值都导致设计不可解（可用点不足）。')
  if (input.mode === 'sparse' && l1Path.length === 0) notes.push('稀疏拟合的 L1 候选全部失败。')

  const bestBaseLambda = bestBase?.lambda ?? input.fallbackLambdaBase
  const bestL1Lambda = input.mode === 'sparse' ? bestL1?.lambda ?? input.fallbackLambdaL1 : 0

  return {
    mode: input.mode,
    weighting: input.base.weighting,
    lambdaBase: bestBaseLambda,
    lambdaL1: bestL1Lambda,
    basePath,
    l1Path,
    usedSampleIds,
    metric: input.metric,
    sampleCount: usedSampleIds.length,
    note: buildTuningNote(input.metric, bestBase, bestL1, usedSampleIds, input.mode),
    feasible: basePath.length > 0,
    bestBase,
    bestL1: input.mode === 'sparse' ? bestL1 : null,
  }
}

function buildTuningNote(
  metric: SelectionMetric,
  bestBase: { lambda: number; score: number } | null,
  bestL1: { lambda: number; score: number } | null,
  sampleIds: string[],
  mode: FitMode,
): string {
  const metricName = metric === 'group-rms' ? '已知比例的组分误差' : '留出样品预测残差'
  const parts = [
    `用 ${sampleIds.length} 个独立标定样（${sampleIds.join('、')}）按“${metricName}”选参。`,
  ]
  if (bestBase) parts.push(`基线正则 λ_b = ${formatNumber(bestBase.lambda)}（${bestBase.score.toFixed(4)}）。`)
  if (mode === 'sparse' && bestL1) {
    parts.push(`L1 正则 λ₁ = ${formatNumber(bestL1.lambda)}（${bestL1.score.toFixed(4)}，取 2% 近优带内最稀疏者）。`)
  }
  return parts.join(' ')
}

function formatNumber(v: number): string {
  if (v === 0) return '0'
  if (Math.abs(v) >= 1 || Math.abs(v) < 0.001) return v.toPrecision(3)
  return v.toFixed(4)
}

export interface AuditRow {
  quantityId: string
  label: string
  memberIds: string[]
  truth: number
  estimate: number
  ci95: number | null
  absError: number
  relError: number | null
  merged: boolean
}

export interface AuditResult {
  rows: AuditRow[]
  unmodeled: { componentId: string; name: string; truth: number }[]
  contaminantRms: number | null
  baselineRms: number | null
  truthAvailable: boolean
  totalAbsError: number
  totalTruth: number
}

/**
 * Truth check. The estimator never reads sample.truth; this function is only
 * reachable from the audit panel, and it compares group sums (the quantities
 * the fit can actually identify) against the known mixing ratios.
 */
export function audit(snapshot: FitSnapshot, dataset: Dataset): AuditResult {
  const sample = dataset.samples.find((s) => s.id === snapshot.sampleId)
  if (!sample?.truth) {
    return {
      rows: [],
      unmodeled: [],
      contaminantRms: null,
      baselineRms: null,
      truthAvailable: false,
      totalAbsError: 0,
      totalTruth: 0,
    }
  }
  const rows: AuditRow[] = []
  let totalAbsError = 0
  let totalTruth = 0
  for (const g of snapshot.groupEstimates) {
    const truth = groupTruth(sample.truth, g.memberIds)
    const absError = g.value - truth
    totalAbsError += Math.abs(absError)
    totalTruth += Math.abs(truth)
    rows.push({
      quantityId: g.groupId,
      label: g.memberIds.join(' + '),
      memberIds: g.memberIds,
      truth,
      estimate: g.value,
      ci95: g.ci95,
      absError,
      relError: Math.abs(truth) > 1e-9 ? absError / truth : null,
      merged: g.merged,
    })
  }
  rows.sort((a, b) => Math.abs(b.absError) - Math.abs(a.absError))
  const modeled = new Set(snapshot.activeReferenceIds)
  const unmodeled = Object.entries(sample.truth)
    .filter(([id, v]) => !modeled.has(id) && v > 0)
    .map(([id, v]) => ({ componentId: id, name: dataset.contaminant?.id === id ? dataset.contaminant.name : `未建模组分 ${id}`, truth: v }))

  let contaminantRms: number | null = null
  if (dataset.contaminant && sample.contaminantTruth) {
    // Amplitude of the unmodelled contaminant that leaks into the residual.
    const units = dataset.contaminant.values
    let dotp = 0
    let norm = 0
    const residualByIndex = new Map<number, number>()
    snapshot.wavelength.forEach((w, i) => residualByIndex.set(w, snapshot.residual[i]))
    for (let i = 0; i < dataset.wavelength.length; i++) {
      const r = residualByIndex.get(dataset.wavelength[i])
      if (r === undefined) continue
      dotp += r * units[i]
      norm += units[i] * units[i]
    }
    if (norm > 0) contaminantRms = dotp / norm
  }

  let baselineRms: number | null = null
  if (sample.baselineTruth) {
    const truthByIndex = new Map<number, number>()
    snapshot.wavelength.forEach((w, i) => truthByIndex.set(w, snapshot.baseline[i]))
    let ss = 0
    let count = 0
    sample.baselineTruth.forEach((v, i) => {
      const est = truthByIndex.get(dataset.wavelength[i])
      if (est === undefined) return
      ss += (est - v) ** 2
      count++
    })
    if (count) baselineRms = Math.sqrt(ss / count)
  }

  return {
    rows,
    unmodeled,
    contaminantRms,
    baselineRms,
    truthAvailable: true,
    totalAbsError,
    totalTruth,
  }
}

export { buildSnapshot, identifiability }
export type { ComponentCoverage, MaskRange, Weighting, TuningConfig }
