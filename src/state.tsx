import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  Dataset,
  FitConfig,
  FitMode,
  FitSnapshot,
  HistoryEntry,
  IdentifiabilityReport,
  MaskRange,
  TuningResult,
  Weighting,
} from './lib/types'
import type { Design } from './lib/design'
import { buildDesign, identifiability } from './lib/design'
import { buildSnapshot, solve } from './lib/fit'
import { buildBuiltinDataset, libraryById, sampleById } from './lib/data'
import { tune } from './lib/calibration'
import { isCompatible, loadHistory, MAX_HISTORY, saveHistory } from './lib/storage'
import { exportDataset, parseDataset } from './lib/io'

export type Theme = 'auto' | 'light' | 'dark'
export type BrushMode = 'mask' | 'window'

interface LiveDesign {
  design: Design | null
  report: IdentifiabilityReport | null
  error: string | null
}

export interface Workbench {
  dataset: Dataset
  libraryId: string
  library: ReturnType<typeof libraryById>
  sampleId: string
  sample: ReturnType<typeof sampleById>
  setLibrary: (id: string) => void
  setSample: (id: string) => void

  activeIds: string[]
  toggleActive: (id: string) => void
  setAllActive: (on: boolean) => void

  validRange: [number, number]
  setValidRange: (range: [number, number]) => void
  masks: MaskRange[]
  addMask: (from: number, to: number) => void
  removeMask: (id: string) => void
  clearMasks: () => void
  brushMode: BrushMode
  setBrushMode: (mode: BrushMode) => void

  mode: FitMode
  setMode: (mode: FitMode) => void
  weighting: Weighting
  setWeighting: (w: Weighting) => void

  degree: number
  setDegree: (n: number) => void
  bound: number
  setBound: (n: number) => void
  lambdaBase: number
  setLambdaBase: (v: number) => void
  lambdaL1: number
  setLambdaL1: (v: number) => void

  calibIds: string[]
  toggleCalib: (id: string) => void
  tuning: TuningResult | null
  runTuning: () => void

  config: FitConfig
  live: LiveDesign
  snapshot: FitSnapshot | null
  solveError: string | null
  solveNow: () => void
  compatible: boolean
  staleReasons: string[]

  history: HistoryEntry[]
  viewHistory: (entry: HistoryEntry) => void
  clearHistory: () => void

  theme: Theme
  setTheme: (t: Theme) => void

  importError: string | null
  importDatasetFile: (file: File) => void
  resetDataset: () => void
  exportCurrent: () => void
}

const Ctx = createContext<Workbench | null>(null)

export function useWorkbench(): Workbench {
  const value = useContext(Ctx)
  if (!value) throw new Error('useWorkbench 必须在 WorkbenchProvider 内使用。')
  return value
}

let maskSeq = 0

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const builtin = useMemo(() => buildBuiltinDataset(), [])
  const [dataset, setDataset] = useState<Dataset>(builtin)
  const [libraryId, setLibraryId] = useState(builtin.libraries[0].id)
  const [sampleId, setSampleId] = useState('UN-01')
  const [activeIds, setActiveIds] = useState<string[]>(builtin.libraries[0].references.map((r) => r.id))
  const [validRange, setValidRangeState] = useState<[number, number]>(builtin.validRange)
  const [masks, setMasks] = useState<MaskRange[]>([])
  const [brushMode, setBrushMode] = useState<BrushMode>('mask')
  const [mode, setMode] = useState<FitMode>('weighted')
  const [weighting, setWeighting] = useState<Weighting>('noise')
  const [degree, setDegree] = useState(4)
  const [bound, setBound] = useState(2)
  const [lambdaBase, setLambdaBase] = useState(0.001)
  const [lambdaL1, setLambdaL1] = useState(0.01)
  const [calibIds, setCalibIds] = useState<string[]>(builtin.samples.filter((s) => s.kind === 'calibration').map((s) => s.id))
  const [tuning, setTuning] = useState<TuningResult | null>(null)
  const [snapshot, setSnapshot] = useState<FitSnapshot | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory())
  const [theme, setTheme] = useState<Theme>('auto')
  const [importError, setImportError] = useState<string | null>(null)
  const didInit = useRef(false)
  const snapshotRef = useRef<FitSnapshot | null>(null)

  const library = libraryById(dataset, libraryId)
  const sample = sampleById(dataset, sampleId)

  useEffect(() => {
    saveHistory(history)
  }, [history])

  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  const setLibrary = useCallback(
    (id: string) => {
      const lib = libraryById(dataset, id)
      if (!lib) return
      setLibraryId(id)
      // New reference set ⇒ identifiability must be decided afresh; start from
      // the full candidate set and keep every wavelength/setting choice.
      setActiveIds(lib.references.map((r) => r.id))
      setTuning(null)
    },
    [dataset],
  )

  const setSample = useCallback((id: string) => {
    setSampleId(id)
  }, [])

  const toggleActive = useCallback((id: string) => {
    setActiveIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    setTuning(null)
  }, [])

  const setAllActive = useCallback(
    (on: boolean) => {
      if (!library) return
      setActiveIds(on ? library.references.map((r) => r.id) : [])
      setTuning(null)
    },
    [library],
  )

  const setValidRange = useCallback((range: [number, number]) => {
    setValidRangeState([Math.min(range[0], range[1]), Math.max(range[0], range[1])])
  }, [])

  const addMask = useCallback((from: number, to: number) => {
    maskSeq += 1
    setMasks((prev) => [...prev, { id: `m${maskSeq}`, from: Math.min(from, to), to: Math.max(from, to) }])
  }, [])

  const removeMask = useCallback((id: string) => {
    setMasks((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const clearMasks = useCallback(() => setMasks([]), [])

  const toggleCalib = useCallback((id: string) => {
    setCalibIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const config: FitConfig = useMemo(
    () => ({
      sampleId,
      libraryId,
      activeReferenceIds: activeIds,
      validRange,
      maskRanges: masks.map(({ from, to }) => ({ from, to })),
      mode,
      weighting,
      baselineDegree: degree,
      baselineBound: bound,
      lambdaBase,
      lambdaL1,
    }),
    [sampleId, libraryId, activeIds, validRange, masks, mode, weighting, degree, bound, lambdaBase, lambdaL1],
  )

  const live: LiveDesign = useMemo(() => {
    if (!library || !sample) return { design: null, report: null, error: '请选择参考库与样品。' }
    try {
      const design = buildDesign(dataset, sample, library, config)
      const report = identifiability(design, design.indices.length)
      return { design, report, error: null }
    } catch (e) {
      return { design: null, report: null, error: (e as Error).message }
    }
  }, [dataset, library, sample, config])

  const solveNow = useCallback(() => {
    const lib = libraryById(dataset, libraryId)
    const s = sampleById(dataset, sampleId)
    if (!lib || !s) {
      setSolveError('请选择参考库与样品。')
      return
    }
    try {
      const design = buildDesign(dataset, s, lib, config)
      const result = solve(design, {
        baselineBound: config.baselineBound,
        lambdaBase: config.lambdaBase,
        lambdaL1: config.lambdaL1,
        mode: config.mode,
      })
      const snap = buildSnapshot(design, result, {
        datasetTitle: dataset.title,
        referenceNames: Object.fromEntries(lib.references.map((r) => [r.id, r.name])),
        referenceSlots: Object.fromEntries(lib.references.map((r) => [r.id, r.slot])),
        libraryVersion: lib.version,
        libraryLabel: lib.label,
        validRange: config.validRange,
        maskRanges: config.maskRanges,
      })
      setSolveError(null)
      const prev = snapshotRef.current
      if (prev) {
        const entry: HistoryEntry = {
          fit: prev,
          reason:
            prev.libraryId !== snap.libraryId
              ? `换库归档：${prev.libraryLabel} → ${snap.libraryLabel}`
              : prev.sampleId !== snap.sampleId
                ? `换样归档：${prev.sampleName} → ${snap.sampleName}`
                : '设置变更前的结果',
          archivedAt: Date.now(),
        }
        setHistory((h) => (h.some((e) => e.fit.id === prev.id) ? h : [entry, ...h].slice(0, MAX_HISTORY)))
      }
      snapshotRef.current = snap
      setSnapshot(snap)
    } catch (e) {
      setSolveError((e as Error).message)
    }
  }, [dataset, libraryId, sampleId, config])

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    solveNow()
    // Only the very first render solves automatically; afterwards the user
    // explicitly re-solves so old quotes can be shown side-by-side.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runTuning = useCallback(() => {
    if (!library) return
    const result = tune({
      dataset,
      library,
      base: {
        libraryId,
        activeReferenceIds: activeIds,
        validRange,
        maskRanges: masks.map(({ from, to }) => ({ from, to })),
        mode,
        weighting,
        baselineDegree: degree,
        baselineBound: bound,
      },
      fallbackLambdaBase: lambdaBase,
      fallbackLambdaL1: lambdaL1,
      sampleIds: calibIds,
      metric: 'group-rms',
      candidateBase: [0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3],
      candidateL1: [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1],
      mode,
      baselineBound: bound,
    })
    setTuning(result)
    if (result.feasible) {
      setLambdaBase(result.lambdaBase)
      setLambdaL1(result.lambdaL1)
    }
  }, [dataset, library, libraryId, activeIds, validRange, masks, mode, weighting, degree, bound, calibIds, lambdaBase, lambdaL1])

  const compatible = useMemo(() => {
    if (!snapshot || !library) return false
    return isCompatible(snapshot, config, library, sampleId)
  }, [snapshot, config, library, sampleId])

  const staleReasons = useMemo(() => {
    if (!snapshot || compatible) return []
    const reasons: string[] = []
    if (snapshot.libraryId !== libraryId) reasons.push(`参考库已从「${snapshot.libraryLabel}」更换为当前库`)
    if (snapshot.sampleId !== sampleId) reasons.push(`样品已从 ${snapshot.sampleName} 切换到 ${sample?.name ?? sampleId}`)
    if (snapshot.mode !== mode) reasons.push('拟合模式不同')
    if (snapshot.weighting !== weighting) reasons.push('加权方式不同')
    if (snapshot.baselineDegree !== degree || snapshot.baselineBound !== bound) reasons.push('基线设置不同')
    if (snapshot.lambdaBase !== lambdaBase || snapshot.lambdaL1 !== lambdaL1) reasons.push('正则参数不同')
    if (
      snapshot.validRange[0] !== validRange[0] ||
      snapshot.validRange[1] !== validRange[1] ||
      snapshot.maskRanges.length !== masks.length ||
      snapshot.activeReferenceIds.join(',') !== activeIds.join(',')
    ) {
      reasons.push('波长窗口、屏蔽区或候选组分不同')
    }
    return reasons
  }, [snapshot, compatible, libraryId, sampleId, mode, weighting, degree, bound, lambdaBase, lambdaL1, validRange, masks, activeIds, sample])

  const viewHistory = useCallback((entry: HistoryEntry) => {
    snapshotRef.current = entry.fit
    setSnapshot(entry.fit)
    setSolveError(null)
  }, [])

  const clearHistory = useCallback(() => setHistory([]), [])

  const importDatasetFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const next = parseDataset(String(reader.result ?? ''), file.name)
        setDataset(next)
        setLibraryId(next.libraries[0].id)
        setActiveIds(next.libraries[0].references.map((r) => r.id))
        setSampleId(next.samples[0].id)
        setValidRangeState(next.validRange)
        setMasks([])
        setTuning(null)
        setImportError(null)
      } catch (e) {
        setImportError((e as Error).message)
      }
    }
    reader.onerror = () => setImportError('读取文件失败。')
    reader.readAsText(file)
  }, [])

  const resetDataset = useCallback(() => {
    setDataset(builtin)
    setLibraryId(builtin.libraries[0].id)
    setActiveIds(builtin.libraries[0].references.map((r) => r.id))
    setSampleId('UN-01')
    setValidRangeState(builtin.validRange)
    setMasks([])
    setCalibIds(builtin.samples.filter((s) => s.kind === 'calibration').map((s) => s.id))
    setTuning(null)
    setImportError(null)
  }, [builtin])

  const exportCurrent = useCallback(() => {
    const blob = new Blob([JSON.stringify(exportDataset(dataset), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${dataset.id}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [dataset])

  const value: Workbench = {
    dataset,
    libraryId,
    library,
    sampleId,
    sample,
    setLibrary,
    setSample,
    activeIds,
    toggleActive,
    setAllActive,
    validRange,
    setValidRange,
    masks,
    addMask,
    removeMask,
    clearMasks,
    brushMode,
    setBrushMode,
    mode,
    setMode,
    weighting,
    setWeighting,
    degree,
    setDegree,
    bound,
    setBound,
    lambdaBase,
    setLambdaBase,
    lambdaL1,
    setLambdaL1,
    calibIds,
    toggleCalib,
    tuning,
    runTuning,
    config,
    live,
    snapshot,
    solveError,
    solveNow,
    compatible,
    staleReasons,
    history,
    viewHistory,
    clearHistory,
    theme,
    setTheme,
    importError,
    importDatasetFile,
    resetDataset,
    exportCurrent,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
