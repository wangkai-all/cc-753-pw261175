import type { Dataset, LibraryVersion, ReferenceSpectrum, Sample } from './types'

export const WAVELENGTH_START = 400
export const WAVELENGTH_END = 760
export const WAVELENGTH_STEP = 1

export function buildWavelength(): number[] {
  const out: number[] = []
  for (let w = WAVELENGTH_START; w <= WAVELENGTH_END + 1e-9; w += WAVELENGTH_STEP) {
    out.push(Number(w.toFixed(6)))
  }
  return out
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma
  return Math.exp(-0.5 * z * z)
}

function unitPeak(wavelength: number[], peaks: [number, number, number][]): number[] {
  const values = wavelength.map((w) => peaks.reduce((s, [mu, sigma, amp]) => s + amp * gaussian(w, mu, sigma), 0))
  const max = Math.max(...values)
  return values.map((v) => Math.max(0, v) / max)
}

function blurSpectrum(values: number[], pixels: number): number[] {
  const out = values.map((_, i) => {
    let sum = 0
    let weight = 0
    const reach = Math.ceil(3 * pixels)
    for (let j = -reach; j <= reach; j++) {
      const idx = i + j
      if (idx < 0 || idx >= values.length) continue
      const k = Math.exp(-0.5 * (j / pixels) ** 2)
      sum += values[idx] * k
      weight += k
    }
    return sum / weight
  })
  const max = Math.max(...out)
  return out.map((v) => Math.max(0, v) / max)
}

function combine(a: number[], b: number[], weightA: number, weightB: number): number[] {
  const mixed = a.map((v, i) => weightA * v + weightB * b[i])
  const max = Math.max(...mixed)
  return mixed.map((v) => Math.max(0, v) / max)
}

export const NOISE_BASE = 0.0035

export function noiseSigmaAt(wavelength: number): number {
  return (
    NOISE_BASE +
    0.0062 * gaussian(wavelength, 515, 110) +
    0.0032 * gaussian(wavelength, 690, 48) +
    0.0022 * gaussian(wavelength, 452, 26)
  )
}

export function noiseTruth(wavelength: number[]): number[] {
  return wavelength.map(noiseSigmaAt)
}

interface BaselineCoefficients {
  b0: number
  b1: number
  b2: number
  b3: number
}

function baselineAt(wavelength: number[], coef: BaselineCoefficients): number[] {
  return wavelength.map((w) => {
    const t = (w - 580) / 180
    return (
      coef.b0 +
      coef.b1 * t +
      coef.b2 * t * t +
      coef.b3 * t * t * t
    )
  })
}

function drawNoise(length: number, sigma: number[], rng: () => number): number[] {
  const out = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    const u1 = Math.max(rng(), 1e-12)
    const u2 = rng()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    out[i] = z * sigma[i]
  }
  return out
}

interface SampleSpec {
  id: string
  name: string
  kind: Sample['kind']
  concentrations: Record<string, number>
  contaminant: number
  baseline: BaselineCoefficients
  spikes: { wavelength: number; magnitude: number }[]
  note: string
}

const SPIKES = {
  a: [
    { wavelength: 574, magnitude: 0.085 },
    { wavelength: 641, magnitude: -0.072 },
  ],
  b: [
    { wavelength: 487, magnitude: -0.086 },
    { wavelength: 713, magnitude: 0.079 },
  ],
  c: [{ wavelength: 641, magnitude: 0.074 }],
  d: [
    { wavelength: 574, magnitude: 0.068 },
    { wavelength: 713, magnitude: 0.071 },
  ],
}

/**
 * Synthetic, self-contained dataset.
 *
 * Sample spectra are generated from the *true* component spectra (identical to
 * the v2 library). Library v1 is a legacy calibration shelf: its B reference was
 * prepared with heavy A carry-over, so in v1 A and B really are collinear and
 * only the total is identifiable. v2 replaces B with a clean re-measure whose
 * 544 nm band separates the pair. Contaminant P appears in some samples but in
 * no library.
 */
export function buildBuiltinDataset(): Dataset {
  const wavelength = buildWavelength()
  const n = wavelength.length
  const sigma = noiseTruth(wavelength)

  // Component shapes are chosen so that no single reference is close to the
  // cubic baseline basis (R²_bl < 0.8): otherwise the drift is absorbed into
  // that component and its content becomes meaningless.
  const refA = unitPeak(wavelength, [
    [452, 12, 0.3],
    [518, 13, 1.0],
    [566, 20, 0.25],
  ])
  const refB = unitPeak(wavelength, [
    [452, 12, 0.3],
    [518, 13, 1.0],
    [544, 6, 0.35],
    [566, 20, 0.25],
    [628, 18, 0.3],
  ])
  const refC = unitPeak(wavelength, [
    [560, 26, 0.25],
    [604, 17, 0.95],
    [648, 30, 0.2],
  ])
  const refD = unitPeak(wavelength, [
    [470, 14, 0.4],
    [662, 20, 0.75],
    [712, 18, 0.35],
  ])
  const refE = unitPeak(wavelength, [
    [434, 7, 1.0],
    [460, 12, 0.25],
    [498, 30, 0.12],
  ])
  const refF = unitPeak(wavelength, [
    [684, 16, 0.5],
    [722, 10, 0.25],
    [742, 8, 0.15],
  ])
  // Two very narrow lines in gaps between modelled bands: after subtracting
  // any smooth baseline, no library component correlates above 0.2 with it.
  const contaminant = unitPeak(wavelength, [
    [505, 4, 0.9],
    [736, 5, 0.7],
    [560, 55, 0.1],
  ])

  const refBLegacy = blurSpectrum(combine(refA, refB, 0.96, 0.04), 3)

  const refsV1: ReferenceSpectrum[] = [
    { id: 'A', name: '组分 A · 芳环', short: 'A', slot: 1, values: refA, note: '主峰 516 nm' },
    {
      id: 'B',
      name: '组分 B · 共轭（旧库）',
      short: 'B',
      slot: 2,
      values: refBLegacy,
      note: '旧库参考：制样时混入了约 96% 的 A，与 A 近乎共线',
    },
    { id: 'C', name: '组分 C · 羰基', short: 'C', slot: 3, values: refC, note: '主峰 604 nm' },
    { id: 'D', name: '组分 D · 宽峰', short: 'D', slot: 4, values: refD, note: '宽包峰 658 nm' },
    { id: 'E', name: '组分 E · 短波', short: 'E', slot: 5, values: refE, note: '窄峰 438 nm' },
  ]

  const refsV2: ReferenceSpectrum[] = [
    { id: 'A', name: '组分 A · 芳环', short: 'A', slot: 1, values: refA, note: '主峰 516 nm' },
    {
      id: 'B',
      name: '组分 B · 共轭（复测）',
      short: 'B',
      slot: 2,
      values: refB,
      note: '高分辨复测：544 nm 特征带显现，与 A 可分离',
    },
    { id: 'C', name: '组分 C · 羰基', short: 'C', slot: 3, values: refC, note: '主峰 604 nm' },
    { id: 'D', name: '组分 D · 宽峰', short: 'D', slot: 4, values: refD, note: '宽包峰 658 nm' },
    { id: 'E', name: '组分 E · 短波', short: 'E', slot: 5, values: refE, note: '窄峰 438 nm' },
    {
      id: 'F',
      name: '组分 F · 长波组分',
      short: 'F',
      slot: 6,
      values: refF,
      note: '新增候选；与 692 nm 污染峰部分重叠，容易被误认为污染',
    },
  ]

  const libraries: LibraryVersion[] = [
    {
      id: 'lib-v1',
      label: '标定库 2025.1',
      version: 'v1',
      note: '旧标定库。B 的参考谱混入了大量 A，与 A 近乎共线，只能联合估计 A+B。',
      references: refsV1,
    },
    {
      id: 'lib-v2',
      label: '标定库 2026.1',
      version: 'v2',
      note: 'B 由高分辨复测替换，544 nm 特征带足以与 A 分开；新增候选 F。更换参考库后必须重新判定可辨识性，旧结果按旧库配套保留。',
      references: refsV2,
    },
  ]

  const trueRefs: Record<string, number[]> = { A: refA, B: refB, C: refC, D: refD, E: refE, F: refF }

  const specs: SampleSpec[] = [
    {
      id: 'CAL-01',
      name: 'CAL-01',
      kind: 'calibration',
      concentrations: { A: 0.65, B: 0.3, C: 0.55, D: 0.2, E: 0.4 },
      contaminant: 0,
      baseline: { b0: 0.12, b1: 0.055, b2: -0.022, b3: 0.018 },
      spikes: [],
      note: '五点标定样，含轻微基线漂移；用于挑选正则参数。',
    },
    {
      id: 'CAL-02',
      name: 'CAL-02',
      kind: 'calibration',
      concentrations: { A: 0.25, B: 0.75, C: 0.1, D: 0.6, E: 0 },
      contaminant: 0,
      baseline: { b0: 0.16, b1: -0.045, b2: 0.028, b3: -0.012 },
      spikes: [],
      note: '四点标定样，D 宽峰占比较高；用于挑选正则参数。',
    },
    {
      id: 'CAL-03',
      name: 'CAL-03',
      kind: 'calibration',
      concentrations: { A: 0.9, B: 0, C: 0.35, D: 0, E: 0.6 },
      contaminant: 0,
      baseline: { b0: 0.1, b1: 0.07, b2: 0.018, b3: 0.026 },
      spikes: [],
      note: '三点标定样，不含 B、D，用于检验稀疏拟合能否压掉零组分。',
    },
    {
      id: 'CAL-04',
      name: 'CAL-04',
      kind: 'calibration',
      concentrations: { A: 0, B: 0.45, C: 0.8, D: 0, E: 0 },
      contaminant: 0,
      baseline: { b0: 0.14, b1: 0.02, b2: -0.03, b3: 0.01 },
      spikes: [],
      note: '两点标定样，B+C；用于挑选正则参数。',
    },
    {
      id: 'VAL-01',
      name: 'VAL-01',
      kind: 'validation',
      concentrations: { A: 0.5, B: 0.2, C: 0.3, D: 0, E: 0.15 },
      contaminant: 0.22,
      baseline: { b0: 0.13, b1: 0.06, b2: -0.02, b3: 0.015 },
      spikes: SPIKES.a,
      note: '验证样：含未建模污染与 2 个局部坏点。',
    },
    {
      id: 'VAL-02',
      name: 'VAL-02',
      kind: 'validation',
      concentrations: { A: 0.1, B: 0.6, C: 0.4, D: 0.5, E: 0 },
      contaminant: 0,
      baseline: { b0: 0.17, b1: -0.03, b2: 0.02, b3: -0.02 },
      spikes: SPIKES.c,
      note: '验证样：无污染，1 个局部坏点。',
    },
    {
      id: 'VAL-03',
      name: 'VAL-03',
      kind: 'validation',
      concentrations: { A: 0.35, B: 0.35, C: 0, D: 0, E: 0.8 },
      contaminant: 0.16,
      baseline: { b0: 0.11, b1: 0.05, b2: 0.015, b3: 0.02 },
      spikes: SPIKES.b,
      note: '验证样：含未建模污染与 2 个局部坏点。',
    },
    {
      id: 'UN-01',
      name: '未知样 UN-01',
      kind: 'unknown',
      concentrations: { A: 0.28, B: 0.22, C: 0.45, D: 0.12, E: 0 },
      contaminant: 0.25,
      baseline: { b0: 0.15, b1: 0.04, b2: -0.025, b3: 0.016 },
      spikes: SPIKES.d,
      note: '内置未知样：含未建模污染与 2 个局部坏点。真值默认隐藏。',
    },
    {
      id: 'UN-02',
      name: '未知样 UN-02',
      kind: 'unknown',
      concentrations: { A: 0.7, B: 0.55, C: 0.05, D: 0, E: 0.3 },
      contaminant: 0,
      baseline: { b0: 0.12, b1: -0.05, b2: 0.014, b3: -0.018 },
      spikes: SPIKES.a,
      note: '内置未知样：无明显污染，2 个局部坏点。',
    },
  ]

  const samples: Sample[] = specs.map((spec, sampleIndex) => {
    const rng = mulberry32(1337 + sampleIndex * 97)
    const signal = new Array<number>(n).fill(0)
    for (const [id, c] of Object.entries(spec.concentrations)) {
      if (!c) continue
      const ref = trueRefs[id]
      for (let i = 0; i < n; i++) signal[i] += c * ref[i]
    }
    for (let i = 0; i < n; i++) signal[i] += spec.contaminant * contaminant[i]
    const baseline = baselineAt(wavelength, spec.baseline)
    const clean = signal.map((v, i) => v + baseline[i])
    const mainNoise = drawNoise(n, sigma, rng)
    const main = clean.map((v, i) => v + mainNoise[i])
    const badPoints: number[] = []
    for (const spike of spec.spikes) {
      const idx = wavelength.findIndex((w) => Math.abs(w - spike.wavelength) < 0.5)
      if (idx >= 0) {
        main[idx] += spike.magnitude
        badPoints.push(idx)
      }
    }
    const replicates = Array.from({ length: 3 }, () => {
      const noise = drawNoise(n, sigma, rng)
      return clean.map((v, i) => v + noise[i])
    })
    return {
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      values: main,
      replicates,
      truth: { ...spec.concentrations },
      baselineTruth: baseline,
      badPointTruth: badPoints,
      contaminantTruth: spec.contaminant,
      note: spec.note,
    }
  })

  return {
    id: 'builtin-spectra-v1',
    title: '内置演示：五组分体系 · 共线旧库 · 未知污染',
    note:
      '全部数据为虚构合成数据，不依赖任何外部仪器。样品光谱按已知混合比例合成，再叠加平滑基线漂移、异方差噪声、局部坏点与未建模污染。真值只用于核对，解算器从不读取。',
    wavelength,
    unit: 'a.u.',
    validRange: [412, 748],
    libraries,
    samples,
    noiseTruth: sigma,
    contaminant: {
      id: 'P',
      name: '未建模污染 P',
      short: 'P',
      slot: 8,
      values: contaminant,
      note: '窄线 505 / 736 nm，不在任何参考库中',
    },
    source: 'builtin',
  }
}

export function libraryById(dataset: Dataset, id: string): LibraryVersion | undefined {
  return dataset.libraries.find((lib) => lib.id === id)
}

export function sampleById(dataset: Dataset, id: string): Sample | undefined {
  return dataset.samples.find((s) => s.id === id)
}

export function referenceMap(library: LibraryVersion): Map<string, ReferenceSpectrum> {
  return new Map(library.references.map((r) => [r.id, r]))
}

export function defaultFitConfig(dataset: Dataset, library: LibraryVersion, sampleId: string) {
  return {
    sampleId,
    libraryId: library.id,
    activeReferenceIds: library.references.map((r) => r.id),
    validRange: dataset.validRange,
    maskRanges: [],
    mode: 'weighted' as const,
    weighting: 'noise' as const,
    baselineDegree: 4,
    baselineBound: 2,
    lambdaBase: 0.001,
    lambdaL1: 0.01,
  }
}

export function referenceCorrelationMatrix(refs: ReferenceSpectrum[]): number[][] {
  const k = refs.length
  const out = refs.map(() => refs.map(() => 1))
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const a = refs[i].values
      const b = refs[j].values
      let ma = 0
      let mb = 0
      for (let r = 0; r < a.length; r++) {
        ma += a[r]
        mb += b[r]
      }
      ma /= a.length
      mb /= a.length
      let va = 0
      let vb = 0
      let cov = 0
      for (let r = 0; r < a.length; r++) {
        const da = a[r] - ma
        const db = b[r] - mb
        va += da * da
        vb += db * db
        cov += da * db
      }
      const c = cov / Math.sqrt(Math.max(va * vb, 1e-20))
      out[i][j] = c
      out[j][i] = c
    }
  }
  return out
}
