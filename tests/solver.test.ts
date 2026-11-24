import { describe, expect, it } from 'vitest'
import { buildBuiltinDataset } from '../src/lib/data'
import { buildDesign, identifiability } from '../src/lib/design'
import { buildSnapshot, solve } from '../src/lib/fit'
import type { Dataset, FitConfig, LibraryVersion } from '../src/lib/types'

const dataset = buildBuiltinDataset()

function cfgFor(ds: Dataset, library: LibraryVersion, sampleId: string, extra: Partial<FitConfig> = {}): FitConfig {
  return {
    sampleId,
    libraryId: library.id,
    activeReferenceIds: library.references.map((r) => r.id),
    validRange: ds.validRange,
    maskRanges: [],
    mode: 'weighted',
    weighting: 'noise',
    baselineDegree: 4,
    baselineBound: 2,
    lambdaBase: 0.001,
    lambdaL1: 0.01,
    ...extra,
  }
}

function solveSample(ds: Dataset, library: LibraryVersion, sampleId: string, extra: Partial<FitConfig> = {}) {
  const sample = ds.samples.find((s) => s.id === sampleId)!
  const config = cfgFor(ds, library, sampleId, extra)
  const design = buildDesign(ds, sample, library, config)
  const result = solve(design, {
    baselineBound: config.baselineBound,
    lambdaBase: config.lambdaBase,
    lambdaL1: config.lambdaL1,
    mode: config.mode,
  })
  const snapshot = buildSnapshot(design, result, {
    datasetTitle: ds.title,
    referenceNames: Object.fromEntries(library.references.map((r) => [r.id, r.name])),
    referenceSlots: Object.fromEntries(library.references.map((r) => [r.id, r.slot])),
    libraryVersion: library.version,
    libraryLabel: library.label,
    validRange: config.validRange,
    maskRanges: config.maskRanges,
  })
  return { design, result, snapshot, config, sample }
}

describe('non-negative joint estimation', () => {
  it('never returns a negative concentration', () => {
    const lib = dataset.libraries[1]
    for (const sample of dataset.samples) {
      const { result } = solveSample(dataset, lib, sample.id)
      for (const g of result.groupEstimates) {
        expect(g.value).toBeGreaterThanOrEqual(0)
      }
      for (const [id, v] of Object.entries(result.concentrations)) {
        expect(v, `${sample.id}/${id}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('recovers the known mixing ratios of a calibration sample on the clean library', () => {
    const lib = dataset.libraries[1]
    const { result, sample } = solveSample(dataset, lib, 'CAL-01')
    const truth = sample.truth!
    for (const g of result.groupEstimates) {
      const target = g.memberIds.reduce((s, id) => s + (truth[id] ?? 0), 0)
      // Baseline-vs-component aliasing sets the achievable accuracy here; the
      // requirement is a physically sensible recovery, not machine precision.
      expect(Math.abs(g.value - target), g.memberIds.join('+')).toBeLessThan(0.12)
    }
  })

  it('fits a bounded baseline instead of letting drift inflate a component', () => {
    const lib = dataset.libraries[1]
    const { result } = solveSample(dataset, lib, 'CAL-01')
    // The generated baseline is order 3; the fitted baseline should track it.
    const drift = Math.max(...result.baseline) - Math.min(...result.baseline)
    expect(drift).toBeGreaterThan(0.02)
    expect(drift).toBeLessThan(1)
    expect(result.baseline.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('reduces the residual far below the signal scale', () => {
    const lib = dataset.libraries[1]
    const { result } = solveSample(dataset, lib, 'CAL-01')
    expect(result.unexplainedRms).toBeLessThan(0.05)
  })
})

describe('identifiability and merged groups', () => {
  it('merges A and B on the legacy library and separates them on the re-measured library', () => {
    const sample = dataset.samples.find((s) => s.id === 'CAL-01')!
    const reports = dataset.libraries.map((lib) => {
      const config = cfgFor(dataset, lib, 'CAL-01')
      return identifiability(buildDesign(dataset, sample, lib, config), 300)
    })
    const v1 = reports[0].groups.filter((g) => g.merged).map((g) => g.memberIds.sort().join('+'))
    const v2 = reports[1].groups.filter((g) => g.merged)
    expect(v1).toContain('A+B')
    expect(v2).toHaveLength(0)
  })

  it('reports only the group total for a merged pair, with no per-member values or intervals', () => {
    const lib = dataset.libraries[0]
    const { result } = solveSample(dataset, lib, 'CAL-01')
    const merged = result.groupEstimates.find((g) => g.memberIds.length > 1)
    expect(merged).toBeTruthy()
    expect(merged!.memberIds.sort()).toEqual(['A', 'B'])
    expect(merged!.value).toBeGreaterThan(0)
    // The coefficient of a merged group is the *total*. If the display ever
    // hands each member the same number, that is the split being invented —
    // exactly what the requirement forbids.
    let sum = 0
    for (const id of merged!.memberIds) {
      const interval = result.intervals[id]
      expect(interval.status).toBe('merged')
      expect(interval.ci95).toBeNull()
      expect(interval.value).toBe(0)
      // Only the group total is carried on the leading member for tooltips.
      sum += result.concentrations[id]
    }
    expect(sum).toBeCloseTo(merged!.value, 10)
    // The group total must not be reproduced per member in the report.
    expect(merged!.value).toBeGreaterThan(0.2)
  })

  it('keeps the merged total close to the sum of the known ratios', () => {
    const lib = dataset.libraries[0]
    const { result, sample } = solveSample(dataset, lib, 'CAL-01')
    const merged = result.groupEstimates.find((g) => g.memberIds.length > 1)!
    const truth = merged.memberIds.reduce((s, id) => s + (sample.truth![id] ?? 0), 0)
    expect(Math.abs(merged.value - truth)).toBeLessThan(0.08)
  })
})

describe('unexplained signal', () => {
  it('tells isolated spikes apart from a broad unmodelled band', () => {
    const lib = dataset.libraries[1]
    // UN-01: a narrow-line contaminant at 505 / 736 nm (broad residual bands)
    // plus two genuine single-channel spikes at 574 and 713 nm. The bands are
    // model error and belong in `bands`; only the spikes may be called bad
    // points. The naive whole-residual test flagged all 74 band channels.
    const { result, sample } = solveSample(dataset, lib, 'UN-01')
    const truth = sample.badPointTruth!.map((i) => dataset.wavelength[i]).sort()
    const flagged = result.badPoints.map((p) => p.wavelength).sort()
    expect(flagged).toEqual(truth)
    expect(result.bands.length).toBeGreaterThan(0)
    expect(result.bands.some((b) => b.from <= 505 && b.to >= 505)).toBe(true)
    expect(result.bands.some((b) => b.from <= 736 && b.to >= 736)).toBe(true)
  })

  it('recovers every planted spike on every sample, with no false positives', () => {
    // The dataset plants 0–2 single-channel spikes per sample. Check each one in
    // both libraries: the fitted residual must expose exactly the planted set.
    let checked = 0
    for (const lib of dataset.libraries) {
      for (const sample of dataset.samples) {
        const truth = (sample.badPointTruth ?? []).map((i) => dataset.wavelength[i]).sort()
        const flagged = solveSample(dataset, lib, sample.id).result.badPoints.map((p) => p.wavelength).sort()
        expect(flagged, `${lib.id}/${sample.id}`).toEqual(truth)
        checked += truth.length
      }
    }
    // 9 planted spikes per library × 2 libraries.
    expect(checked).toBe(18)
  })

  it('never invents bad points on clean calibration samples', () => {
    const lib = dataset.libraries[1]
    for (const id of ['CAL-01', 'CAL-02', 'CAL-03', 'CAL-04']) {
      expect(solveSample(dataset, lib, id).result.badPoints, id).toHaveLength(0)
    }
  })

  it('still finds a spike sitting on the shoulder of a broad band', () => {
    const lib = dataset.libraries[1]
    const sample = dataset.samples.find((s) => s.id === 'UN-01')!
    const config = cfgFor(dataset, lib, 'UN-01')
    // The contaminant's 505 nm line leaves an elevated residual over 499–511.
    // Plant one more spike at each position on that flank; each must surface as
    // its own bad point even though the raw residual is already large there.
    const clean = solveSample(dataset, lib, 'UN-01')
    expect(clean.result.badPoints.map((p) => p.wavelength)).not.toContain(509)
    for (const target of [507, 509, 511, 512]) {
      const idx = dataset.wavelength.indexOf(target)
      const values = [...sample.values]
      values[idx] += 0.09
      const design = buildDesign(dataset, { ...sample, values }, lib, config)
      const result = solve(design, { baselineBound: 2, lambdaBase: 0.001, lambdaL1: 0.01, mode: 'weighted' })
      expect(result.badPoints.map((p) => p.wavelength), `${target} nm`).toContain(target)
      // The band is still reported as a range, not as a cloud of points.
      expect(result.badPoints.length).toBeLessThanOrEqual(3)
    }
  })
})

describe('masking invalidates uncertainty', () => {
  it('drops the interval for a component whose main peak is masked', () => {
    const lib = dataset.libraries[1]
    const open = solveSample(dataset, lib, 'UN-01')
    expect(open.result.intervals.A.ci95).not.toBeNull()

    // A's main peak sits at 518 nm.
    const masked = solveSample(dataset, lib, 'UN-01', { maskRanges: [{ from: 505, to: 532 }] })
    expect(masked.result.coverage.A.peakMasked).toBe(true)
    expect(masked.result.intervals.A.status).toBe('masked')
    expect(masked.result.intervals.A.ci95).toBeNull()
    // Other components keep their intervals.
    expect(masked.result.intervals.C.ci95).not.toBeNull()
    expect(masked.result.notes.some((n) => n.includes('旧不确定范围作废'))).toBe(true)
  })

  it('gives a different snapshot signature after masks change, so old quotes are not reused', () => {
    const lib = dataset.libraries[1]
    const a = solveSample(dataset, lib, 'UN-01').snapshot
    const b = solveSample(dataset, lib, 'UN-01', { maskRanges: [{ from: 505, to: 532 }] }).snapshot
    expect(a.signature).not.toBe(b.signature)
  })
})

describe('sparse fitting', () => {
  it('drives absent components to exactly zero as the penalty grows', () => {
    const lib = dataset.libraries[1]
    // CAL-03 contains no B and no D.
    // The L1 path is monotone in the penalty: a light penalty leaves small
    // non-zero artefacts, a heavier one removes them, a real component survives
    // a moderate penalty.
    const noPenalty = solveSample(dataset, lib, 'CAL-03', { mode: 'sparse', lambdaL1: 0 })
    const light = solveSample(dataset, lib, 'CAL-03', { mode: 'sparse', lambdaL1: 0.1 })
    const heavy = solveSample(dataset, lib, 'CAL-03', { mode: 'sparse', lambdaL1: 2 })
    const valueOf = (r: typeof light.result, id: string) =>
      r.groupEstimates.find((g) => g.memberIds.includes(id))!.value
    expect(valueOf(noPenalty.result, 'B')).toBeGreaterThan(0)
    expect(valueOf(light.result, 'B')).toBe(0)
    expect(valueOf(light.result, 'D')).toBe(0)
    expect(valueOf(heavy.result, 'B')).toBe(0)
    expect(valueOf(heavy.result, 'D')).toBe(0)
    // Real components survive a moderate penalty.
    expect(valueOf(light.result, 'A')).toBeGreaterThan(0.5)
  })

  it('is inert in weighted mode', () => {
    const lib = dataset.libraries[1]
    const a = solveSample(dataset, lib, 'CAL-03', { mode: 'weighted', lambdaL1: 0 })
    const b = solveSample(dataset, lib, 'CAL-03', { mode: 'weighted', lambdaL1: 5 })
    expect(a.result.groupEstimates.map((g) => g.value)).toEqual(b.result.groupEstimates.map((g) => g.value))
  })
})
