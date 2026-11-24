import { describe, expect, it } from 'vitest'
import { buildBuiltinDataset } from '../src/lib/data'
import { exportDataset, parseDataset, DatasetError } from '../src/lib/io'
import { isCompatible } from '../src/lib/storage'
import { buildDesign } from '../src/lib/design'
import { buildSnapshot, solve } from '../src/lib/fit'
import type { FitConfig } from '../src/lib/types'

const dataset = buildBuiltinDataset()

describe('dataset import/export round trip', () => {
  it('re-exports the builtin dataset and parses it back', () => {
    const text = JSON.stringify(exportDataset(dataset))
    const back = parseDataset(text, 'roundtrip.json')
    expect(back.wavelength.length).toBe(dataset.wavelength.length)
    expect(back.libraries.map((l) => l.id)).toEqual(dataset.libraries.map((l) => l.id))
    expect(back.samples.map((s) => s.id)).toEqual(dataset.samples.map((s) => s.id))
    expect(back.samples[0].truth).toBeDefined()
    expect(back.validRange).toEqual(dataset.validRange)
    expect(back.contaminant?.id).toBe('P')
  })

  it('rejects malformed payloads with a readable message', () => {
    expect(() => parseDataset('not json', 'x.json')).toThrow(DatasetError)
    expect(() => parseDataset('{}', 'x.json')).toThrow(/format/)
    const missingLength = exportDataset(dataset) as unknown as Record<string, unknown>
    const samples = (missingLength.samples as { values: number[] }[]).map((s) => ({ ...s }))
    samples[0].values = samples[0].values.slice(0, 3)
    expect(() => parseDataset(JSON.stringify({ ...missingLength, samples }), 'x.json')).toThrow(/长度/)
  })

  it('rejects a non-increasing wavelength grid', () => {
    const raw = exportDataset(dataset) as unknown as { wavelength: number[] }
    const wavelength = [...raw.wavelength]
    wavelength[10] = wavelength[9]
    expect(() => parseDataset(JSON.stringify({ ...raw, wavelength }), 'x.json')).toThrow(/递增/)
  })

  it('drops samples with a single replicate instead of pretending there is noise data', () => {
    const raw = exportDataset(dataset) as unknown as { samples: { replicates?: number[][] }[] }
    const samples = raw.samples.map((s, i) => (i === 0 ? { ...s, replicates: [s.replicates![0]] } : s))
    const back = parseDataset(JSON.stringify({ ...raw, samples }), 'x.json')
    expect(back.samples[0].replicates).toBeUndefined()
  })
})

describe('history compatibility', () => {
  const lib = dataset.libraries[1]
  const sample = dataset.samples.find((s) => s.id === 'UN-01')!
  const base: FitConfig = {
    sampleId: sample.id,
    libraryId: lib.id,
    activeReferenceIds: lib.references.map((r) => r.id),
    validRange: dataset.validRange,
    maskRanges: [],
    mode: 'weighted',
    weighting: 'noise',
    baselineDegree: 4,
    baselineBound: 2,
    lambdaBase: 0.001,
    lambdaL1: 0.01,
  }

  function snapshotFor(config: FitConfig) {
    const design = buildDesign(dataset, sample, lib, config)
    const result = solve(design, {
      baselineBound: config.baselineBound,
      lambdaBase: config.lambdaBase,
      lambdaL1: config.lambdaL1,
      mode: config.mode,
    })
    return buildSnapshot(design, result, {
      datasetTitle: dataset.title,
      referenceNames: Object.fromEntries(lib.references.map((r) => [r.id, r.name])),
      referenceSlots: Object.fromEntries(lib.references.map((r) => [r.id, r.slot])),
      libraryVersion: lib.version,
      libraryLabel: lib.label,
      validRange: config.validRange,
      maskRanges: config.maskRanges,
    })
  }

  it('accepts an unchanged configuration', () => {
    const snap = snapshotFor(base)
    expect(isCompatible(snap, base, lib, sample.id)).toBe(true)
  })

  it('rejects the quote when the window, mask, mode or lambda changes', () => {
    const snap = snapshotFor(base)
    expect(isCompatible(snap, { ...base, maskRanges: [{ from: 500, to: 530 }] }, lib, sample.id)).toBe(false)
    expect(isCompatible(snap, { ...base, validRange: [420, 740] }, lib, sample.id)).toBe(false)
    expect(isCompatible(snap, { ...base, mode: 'sparse' }, lib, sample.id)).toBe(false)
    expect(isCompatible(snap, { ...base, weighting: 'uniform' }, lib, sample.id)).toBe(false)
    expect(isCompatible(snap, { ...base, baselineDegree: 3 }, lib, sample.id)).toBe(false)
    expect(isCompatible(snap, { ...base, lambdaBase: 0.01 }, lib, sample.id)).toBe(false)
    expect(isCompatible(snap, { ...base, activeReferenceIds: base.activeReferenceIds.slice(0, 3) }, lib, sample.id)).toBe(false)
  })

  it('rejects a quote from a different sample or library', () => {
    const snap = snapshotFor(base)
    expect(isCompatible(snap, base, lib, 'UN-02')).toBe(false)
    const other = dataset.libraries[0]
    expect(isCompatible(snap, base, other, sample.id)).toBe(false)
  })

  it('treats mask order as irrelevant', () => {
    const a = snapshotFor({ ...base, maskRanges: [{ from: 440, to: 450 }, { from: 520, to: 530 }] })
    const b = { ...base, maskRanges: [{ from: 520, to: 530 }, { from: 440, to: 450 }] }
    expect(isCompatible(a, b, lib, sample.id)).toBe(true)
  })
})
