import type { FitConfig, FitSnapshot, HistoryEntry, LibraryVersion } from './types'

export const STORAGE_KEY = 'spectra-workbench/history/v1'
export const SETTINGS_KEY = 'spectra-workbench/settings/v1'
export const MAX_HISTORY = 40

export interface StoredHistory {
  version: 1
  entries: HistoryEntry[]
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredHistory
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(isHistoryEntry).slice(0, MAX_HISTORY)
  } catch {
    return []
  }
}

export function saveHistory(entries: HistoryEntry[]): void {
  const payload: StoredHistory = { version: 1, entries: entries.slice(0, MAX_HISTORY) }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Storage full or disabled: the in-memory history still works.
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<HistoryEntry>
  return Boolean(v.fit && typeof v.fit.id === 'string' && Array.isArray(v.fit.wavelength))
}

export interface Settings {
  libraryId: string
  mode: FitConfig['mode']
  weighting: FitConfig['weighting']
  baselineDegree: number
  baselineBound: number
  lambdaBase: number
  lambdaL1: number
  sampleId: string
}

export function loadSettings(datasetId: string): Settings | null {
  try {
    const raw = localStorage.getItem(`${SETTINGS_KEY}/${datasetId}`)
    if (!raw) return null
    return JSON.parse(raw) as Settings
  } catch {
    return null
  }
}

export function saveSettings(datasetId: string, settings: Settings): void {
  try {
    localStorage.setItem(`${SETTINGS_KEY}/${datasetId}`, JSON.stringify(settings))
  } catch {
    // ignore
  }
}

/**
 * A quote is *compatible* with the current state only if every input that
 * could change it is identical: same sample, same library version and exact
 * reference spectra, same window, masks, mode, weighting, baseline, and
 * regularisation. Anything else and the old number must not be shown as if
 * it were current.
 */
export function isCompatible(
  fit: FitSnapshot,
  config: FitConfig,
  library: LibraryVersion,
  sampleId: string,
): boolean {
  if (fit.sampleId !== sampleId) return false
  if (fit.libraryId !== library.id || fit.libraryVersion !== library.version) return false
  if (fit.signature === '') return false
  const key = JSON.stringify({
    dataset: sampleId,
    library: library.id,
    active: config.activeReferenceIds,
    validRange: config.validRange,
    masks: [...config.maskRanges].map((m) => ({ from: m.from, to: m.to })).sort((a, b) => a.from - b.from),
    mode: config.mode,
    weighting: config.weighting,
    degree: config.baselineDegree,
    lambdaBase: config.lambdaBase,
    lambdaL1: config.lambdaL1,
    bound: config.baselineBound,
  })
  return fit.signature === key
}

export function describeIncompatibility(fit: FitSnapshot, library: LibraryVersion): string[] {
  const reasons: string[] = []
  if (fit.libraryId !== library.id || fit.libraryVersion !== library.version) {
    reasons.push(`参考库不同（结果来自 ${fit.libraryLabel}）`)
  }
  reasons.push('窗口、屏蔽区、权重或正则参数与当前设置不同')
  return reasons
}
