import { buildBuiltinDataset } from '../src/lib/data'
import { buildDesign, identifiability } from '../src/lib/design'
import { solve, buildSnapshot } from '../src/lib/fit'
import { tune, audit } from '../src/lib/calibration'
import type { FitConfig } from '../src/lib/types'

const dataset = buildBuiltinDataset()
const lib = dataset.libraries[0]
const lib2 = dataset.libraries[1]
const base = (libIdx: number): FitConfig => ({
  sampleId: 'UN-01',
  libraryId: dataset.libraries[libIdx].id,
  activeReferenceIds: dataset.libraries[libIdx].references.map((r) => r.id),
  validRange: dataset.validRange,
  maskRanges: [],
  mode: 'weighted',
  weighting: 'noise',
  baselineDegree: 4,
  baselineBound: 2,
  lambdaBase: 0.02,
  lambdaL1: 0.01,
})

function run(sampleId: string, cfg: FitConfig, libIdx: number) {
  const library = dataset.libraries[libIdx]
  const sample = dataset.samples.find((s) => s.id === sampleId)!
  const design = buildDesign(dataset, sample, library, cfg)
  const result = solve(design, {
    baselineBound: cfg.baselineBound,
    lambdaBase: cfg.lambdaBase,
    lambdaL1: cfg.lambdaL1,
    mode: cfg.mode,
  })
  const snap = buildSnapshot(design, result, {
    datasetTitle: dataset.title,
    referenceNames: Object.fromEntries(library.references.map((r) => [r.id, r.name])),
    referenceSlots: Object.fromEntries(library.references.map((r) => [r.id, r.slot])),
    libraryVersion: library.version,
    libraryLabel: library.label,
    validRange: cfg.validRange,
    maskRanges: cfg.maskRanges,
  })
  return { result, snap, design }
}

for (const [label, idx] of [['v1', 0], ['v2', 1]] as const) {
  const cfg = base(idx)
  const d = buildDesign(dataset, dataset.samples[7], dataset.libraries[idx], cfg)
  const rep = identifiability(d, d.indices.length)
  console.log(`=== identifiability ${label} ===`)
  console.log(rep.groups.map((g) => `${g.id}:${g.memberIds.join('+')} merged=${g.merged} cond=${g.condition.toFixed(1)}`).join(' | '))
  console.log('overall cond', rep.condition.toFixed(1))
  for (const sid of ['CAL-01', 'UN-01', 'UN-02', 'VAL-01', 'VAL-02', 'VAL-03']) {
    const { result, snap } = run(sid, cfg, idx)
    const a = audit(snap, dataset)
    console.log(sid, 'chi2', result.chi2Reduced.toFixed(2), 'rms', result.unexplainedRms.toFixed(4))
    console.log('  ', a.rows.map((r) => `${r.label}: ${r.estimate.toFixed(3)} vs ${r.truth.toFixed(3)} err ${r.absError.toFixed(3)}${r.ci95 ? ' ci' + r.ci95.toFixed(3) : ''}`).join(' | '))
    if (a.contaminantRms !== null) console.log('   contaminant est', a.contaminantRms.toFixed(3), 'baselineRms', a.baselineRms?.toFixed(4))
  }
}

console.log('\n=== tuning v2 sparse ===')
const cfg2 = base(1)
const t = tune({
  dataset,
  library: lib2,
  base: { ...cfg2 },
  fallbackLambdaBase: 0.02,
  fallbackLambdaL1: 0.01,
  sampleIds: ['CAL-01', 'CAL-02', 'CAL-03', 'CAL-04'],
  metric: 'group-rms',
  candidateBase: [0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3],
  candidateL1: [0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1],
  mode: 'sparse',
  baselineBound: 2,
})
console.log(t.basePath.map((p) => `${p.lambda}:${p.score.toFixed(4)}`).join(' '))
console.log(t.l1Path.map((p) => `${p.lambda}:${p.score.toFixed(4)}/${p.activeCount.toFixed(1)}`).join(' '))
console.log(t.note)
console.log('chosen', t.lambdaBase, t.lambdaL1)
