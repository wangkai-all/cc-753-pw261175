import { useRef } from 'react'
import type { Theme } from '../state'
import { useWorkbench } from '../state'
import { Seg } from './ui'

export function Topbar() {
  const wb = useWorkbench()
  const fileRef = useRef<HTMLInputElement | null>(null)
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">SPECTRA</span>
        <span className="brand-sub">{wb.dataset.title}</span>
      </div>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <Seg<Theme>
          ariaLabel="配色主题"
          value={wb.theme}
          onChange={wb.setTheme}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
          ]}
        />
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          导入数据
        </button>
        <input
          ref={fileRef}
          className="file-input"
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) wb.importDatasetFile(file)
            e.target.value = ''
          }}
        />
        <button type="button" className="btn" onClick={wb.exportCurrent}>
          导出数据
        </button>
        {wb.dataset.source === 'imported' && (
          <button type="button" className="btn btn-ghost" onClick={wb.resetDataset}>
            恢复内置
          </button>
        )}
      </div>
    </header>
  )
}

export function StaleBanner() {
  const wb = useWorkbench()
  return (
    <>
      {wb.importError && (
        <div className="banner" role="alert">
          <strong>导入失败：</strong>
          {wb.importError}
          <button type="button" className="btn btn-sm" onClick={wb.resetDataset}>
            恢复内置数据
          </button>
        </div>
      )}
      {wb.snapshot && !wb.compatible && (
        <div className="banner" role="status">
          <strong>当前显示的是旧解算结果。</strong>
          {wb.staleReasons.length ? `原因：${wb.staleReasons.join('；')}。` : ''}
          旧结果保留在历史中，但不会再被当作当前结论。
          <button type="button" className="btn btn-sm btn-primary" onClick={wb.solveNow}>
            按当前设置重新解算
          </button>
        </div>
      )}
    </>
  )
}
