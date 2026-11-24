export type SampleKind = 'calibration' | 'validation' | 'unknown'

export interface ReferenceSpectrum {
  id: string
  name: string
  short: string
  /** Categorical palette slot, 1-8. Stable across library versions. */
  slot: number
  values: number[]
  note?: string
}

export interface LibraryVersion {
  id: string
  label: string
  version: string
  note: string
  references: ReferenceSpectrum[]
}

export interface Sample {
  id: string
  name: string
  kind: SampleKind
  values: number[]
  /**
   * Repeat measurements of this sample. Used only to estimate a per-channel
   * noise scale; the fit uses `values`.
   */
  replicates?: number[][]
  /** Built-in truth. Never read by the estimator; used only by the audit panel. */
  truth?: Record<string, number>
  baselineTruth?: number[]
  badPointTruth?: number[]
  contaminantTruth?: number
  note: string
}

export interface Dataset {
  id: string
  title: string
  note: string
  wavelength: number[]
  unit: string
  validRange: [number, number]
  libraries: LibraryVersion[]
  samples: Sample[]
  noiseTruth?: number[]
  contaminant?: ReferenceSpectrum
  source: 'builtin' | 'imported'
}

export type FitMode = 'weighted' | 'sparse'
export type Weighting = 'noise' | 'uniform'

export interface WavelengthRange {
  from: number
  to: number
}

export interface MaskRange extends WavelengthRange {
  id?: string
  label?: string
}

export interface FitConfig {
  sampleId: string
  libraryId: string
  activeReferenceIds: string[]
  validRange: [number, number]
  maskRanges: WavelengthRange[]
  mode: FitMode
  weighting: Weighting
  baselineDegree: number
  baselineBound: number
  lambdaBase: number
  lambdaL1: number
  selectionMetric?: SelectionMetric
}

export interface IdentifiableGroup {
  id: string
  memberIds: string[]
  /** Max pairwise |correlation| inside the group. */
  maxCorr: number
  /** Condition number of the group's residualised design submatrix. */
  condition: number
  /** True when the group contains more than one reference. */
  merged: boolean
  /** Component is nearly absorbed by the baseline basis. */
  baselineAbsorbed: boolean
}

export interface IdentifiabilityReport {
  libraryId: string
  referenceIds: string[]
  groups: IdentifiableGroup[]
  correlation: number[][]
  condition: number
  effectiveRank: number
  threshold: number
  baselineDegree: number
  wavelengthsUsed: number
  note: string
}

export interface CalibrationPoint {
  lambda: number
  score: number
  predictiveRms: number
  activeCount: number
  perSample: { sampleId: string; score: number; truth: Record<string, number>; estimate: Record<string, number> }[]
}

export interface TuningResult {
  mode: FitMode
  weighting: Weighting
  lambdaBase: number
  lambdaL1: number
  basePath: CalibrationPoint[]
  l1Path: CalibrationPoint[]
  usedSampleIds: string[]
  metric: string
  sampleCount: number
  note: string
  feasible: boolean
  bestBase: { lambda: number; score: number } | null
  bestL1: { lambda: number; score: number } | null
}

export interface ConcentrationInterval {
  componentId: string
  value: number
  ci95: number | null
  status: 'identified' | 'merged' | 'undetected' | 'baseline' | 'masked'
}

export interface GroupEstimate {
  groupId: string
  memberIds: string[]
  value: number
  ci95: number | null
  /** True when the group has more than one member. */
  merged: boolean
}

export interface UnexplainedBand {
  from: number
  to: number
  peakWavelength: number
  peakResidual: number
  integrated: number
}

export interface BadPoint {
  index: number
  wavelength: number
  /** Raw residual at the channel, for the tooltip. */
  residual: number
  /**
   * Significance of the *local* deviation — the jump away from the line through
   * the two-away neighbours, in units of its own standard error. It is not the
   * raw residual z, so a spike sitting on a broad band still scores high while
   * the band itself scores near zero.
   */
  z: number
}

export interface FitSnapshot {
  id: string
  createdAt: number
  sampleId: string
  sampleName: string
  sampleKind: SampleKind
  datasetTitle: string
  signature: string
  wavelength: number[]
  sampleValues: number[]
  sampleNote: string
  libraryId: string
  libraryVersion: string
  libraryLabel: string
  activeReferenceIds: string[]
  referenceNames: Record<string, string>
  referenceSlots: Record<string, number>
  mode: FitMode
  weighting: Weighting
  maskRanges: WavelengthRange[]
  validRange: [number, number]
  baselineDegree: number
  baselineBound: number
  lambdaBase: number
  lambdaL1: number
  concentrations: Record<string, number>
  intervals: Record<string, ConcentrationInterval>
  groups: IdentifiableGroup[]
  groupEstimates: GroupEstimate[]
  groupContributions: Record<string, number[]>
  baseline: number[]
  fitted: number[]
  residual: number[]
  contributions: Record<string, number[]>
  condition: number
  chi2Reduced: number
  unexplainedRms: number
  noiseRms: number
  unexplainedFraction: number
  bands: UnexplainedBand[]
  badPoints: BadPoint[]
  effectiveCount: number
  notes: string[]
  coverage: Record<string, ComponentCoverage>
  ssTotal: number
  ssResidual: number
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
  fit: FitSnapshot
  rows: AuditRow[]
  unmodeled: { componentId: string; name: string; truth: number }[]
  contaminantRms: number | null
  baselineRms: number | null
  sampleId: string
  sampleName: string
}

export interface ComponentCoverage {
  componentId: string
  peakWavelength: number
  peakMasked: boolean
  energyFraction: number
  intervalInvalid: boolean
  reason: string
}

export type SelectionMetric = 'predictive-rms' | 'group-rms'

export interface TuningConfig {
  validationSampleIds: string[]
  metric: SelectionMetric
  candidateBase: number[]
  candidateL1: number[]
}

export interface DesignSummary {
  points: number
  channels: number
  parameters: number
  dof: number
  noiseMedian: number
  noiseSource: 'replicates' | 'second-difference'
}

export interface HistoryEntry {
  fit: FitSnapshot
  reason: string
  archivedAt: number
}
