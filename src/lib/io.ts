import type { Dataset, LibraryVersion, Sample } from './types'

export interface DatasetJson {
  format: 'spectra-workbench'
  version: 1
  title: string
  note: string
  wavelength: number[]
  unit: string
  validRange: [number, number]
  libraries: {
    id: string
    label: string
    version: string
    note: string
    references: { id: string; name: string; short: string; slot: number; values: number[]; note?: string }[]
  }[]
  samples: {
    id: string
    name: string
    kind: Sample['kind']
    values: number[]
    replicates?: number[][]
    truth?: Record<string, number>
    note: string
  }[]
  contaminant?: { id: string; name: string; short: string; slot: number; values: number[]; note?: string }
  noiseTruth?: number[]
}

export function exportDataset(dataset: Dataset): DatasetJson {
  return {
    format: 'spectra-workbench',
    version: 1,
    title: dataset.title,
    note: dataset.note,
    wavelength: dataset.wavelength,
    unit: dataset.unit,
    validRange: dataset.validRange,
    libraries: dataset.libraries.map((lib) => ({
      id: lib.id,
      label: lib.label,
      version: lib.version,
      note: lib.note,
      references: lib.references.map((r) => ({
        id: r.id,
        name: r.name,
        short: r.short,
        slot: r.slot,
        values: r.values,
        note: r.note,
      })),
    })),
    samples: dataset.samples.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      values: s.values,
      replicates: s.replicates,
      truth: s.truth,
      note: s.note,
    })),
    contaminant: dataset.contaminant
      ? {
          id: dataset.contaminant.id,
          name: dataset.contaminant.name,
          short: dataset.contaminant.short,
          slot: dataset.contaminant.slot,
          values: dataset.contaminant.values,
          note: dataset.contaminant.note,
        }
      : undefined,
    noiseTruth: dataset.noiseTruth,
  }
}

export class DatasetError extends Error {}

function isFiniteArray(value: unknown, length?: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    (length === undefined || value.length === length)
  )
}

export function parseDataset(text: string, filename = '导入数据'): Dataset {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new DatasetError('文件不是合法的 JSON。')
  }
  if (!raw || typeof raw !== 'object') throw new DatasetError('JSON 顶层必须是对象。')
  const obj = raw as Partial<DatasetJson>
  if (obj.format !== 'spectra-workbench') {
    throw new DatasetError('缺少 format: "spectra-workbench" 标记。')
  }
  if (!isFiniteArray(obj.wavelength, undefined)) throw new DatasetError('wavelength 必须是数字数组。')
  const n = obj.wavelength.length
  if (n < 40) throw new DatasetError('波长点太少（至少 40）。')
  for (let i = 1; i < n; i++) {
    if (obj.wavelength[i] <= obj.wavelength[i - 1]) throw new DatasetError('wavelength 必须严格递增。')
  }
  if (!Array.isArray(obj.libraries) || obj.libraries.length === 0) throw new DatasetError('至少需要一个参考库。')
  const libraries: LibraryVersion[] = obj.libraries.map((lib, li) => {
    if (!lib || typeof lib.id !== 'string' || !lib.id.trim()) throw new DatasetError(`第 ${li + 1} 个参考库缺少 id。`)
    if (!Array.isArray(lib.references) || lib.references.length === 0) {
      throw new DatasetError(`参考库 ${lib.id} 没有参考谱。`)
    }
    for (const ref of lib.references) {
      if (!ref || typeof ref.id !== 'string') throw new DatasetError(`参考库 ${lib.id} 的参考项缺少 id。`)
      if (!isFiniteArray(ref.values, n)) {
        throw new DatasetError(`参考 ${lib.id}/${ref.id} 的谱长度与 wavelength 不一致。`)
      }
      if (ref.values.every((v) => v === 0)) throw new DatasetError(`参考 ${lib.id}/${ref.id} 全为 0。`)
    }
    const ids = lib.references.map((r) => r.id)
    if (new Set(ids).size !== ids.length) throw new DatasetError(`参考库 ${lib.id} 内组分 id 重复。`)
    return {
      id: lib.id,
      label: typeof lib.label === 'string' ? lib.label : lib.id,
      version: typeof lib.version === 'string' ? lib.version : lib.id,
      note: typeof lib.note === 'string' ? lib.note : '',
      references: lib.references.map((ref) => ({
        id: ref.id,
        name: typeof ref.name === 'string' ? ref.name : ref.id,
        short: typeof ref.short === 'string' && ref.short ? ref.short : ref.id,
        slot: Number.isFinite(ref.slot) ? Math.min(8, Math.max(1, Math.round(ref.slot))) : ((ids.indexOf(ref.id) % 8) + 1),
        values: ref.values,
        note: ref.note,
      })),
    }
  })
  if (!Array.isArray(obj.samples) || obj.samples.length === 0) throw new DatasetError('至少需要一个样品。')
  const samples: Sample[] = obj.samples.map((s, si) => {
    if (!s || typeof s.id !== 'string') throw new DatasetError(`第 ${si + 1} 个样品缺少 id。`)
    if (!isFiniteArray(s.values, n)) throw new DatasetError(`样品 ${s.id} 的谱长度与 wavelength 不一致。`)
    const kind: Sample['kind'] =
      s.kind === 'calibration' || s.kind === 'validation' || s.kind === 'unknown' ? s.kind : 'unknown'
    const replicates = Array.isArray(s.replicates)
      ? s.replicates.filter((r): r is number[] => isFiniteArray(r, n))
      : undefined
    return {
      id: s.id,
      name: typeof s.name === 'string' ? s.name : s.id,
      kind,
      values: s.values,
      replicates: replicates && replicates.length >= 2 ? replicates : undefined,
      truth:
        s.truth && typeof s.truth === 'object'
          ? Object.fromEntries(
              Object.entries(s.truth).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
            )
          : undefined,
      note: typeof s.note === 'string' ? s.note : '',
    }
  })
  if (new Set(samples.map((s) => s.id)).size !== samples.length) throw new DatasetError('样品 id 重复。')
  if (!Array.isArray(obj.validRange) || obj.validRange.length !== 2 || !obj.validRange.every((v) => typeof v === 'number')) {
    throw new DatasetError('validRange 必须是 [起始波长, 结束波长]。')
  }
  const [wLo, wHi] = [obj.wavelength[0], obj.wavelength[n - 1]]
  let validRange: [number, number] = [obj.validRange[0], obj.validRange[1]]
  if (validRange[0] >= validRange[1]) throw new DatasetError('validRange 起点必须小于终点。')
  validRange = [Math.max(wLo, validRange[0]), Math.min(wHi, validRange[1])]
  let contaminant: Dataset['contaminant']
  if (obj.contaminant) {
    if (!isFiniteArray(obj.contaminant.values, n)) throw new DatasetError('污染物参考谱长度不一致。')
    contaminant = {
      id: obj.contaminant.id || 'P',
      name: obj.contaminant.name || '未建模污染',
      short: obj.contaminant.short || 'P',
      slot: obj.contaminant.slot ?? 8,
      values: obj.contaminant.values,
      note: obj.contaminant.note,
    }
  }
  return {
    id: `imported-${Date.now().toString(36)}`,
    title: typeof obj.title === 'string' ? obj.title : filename.replace(/\.json$/i, ''),
    note: typeof obj.note === 'string' ? obj.note : '导入的数据集。',
    wavelength: obj.wavelength,
    unit: typeof obj.unit === 'string' ? obj.unit : 'a.u.',
    validRange,
    libraries,
    samples,
    noiseTruth: isFiniteArray(obj.noiseTruth, n) ? obj.noiseTruth : undefined,
    contaminant,
    source: 'imported',
  }
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
