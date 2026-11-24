import { useMemo, useState } from 'react'
import { useWorkbench } from '../state'
import { Card, Notice, Swatch } from './ui'
import { formatNumber, formatSigned } from '../lib/chart'
import type { ConcentrationInterval } from '../lib/types'

export function RightRail() {
  return (
    <div className="column rail-right">
      <IdentifiabilityCard />
      <ResultsCard />
      <HistoryCard />
      <DesignCard />
    </div>
  )
}

function IdentifiabilityCard() {
  const wb = useWorkbench()
  const report = wb.live.report
  const library = wb.library
  const [openHeat, setOpenHeat] = useState(false)
  if (!report || !library) {
    return (
      <Card title="可辨识性">
        <div className="card-body">
          <div className="empty-block">{wb.live.error ?? '请选择候选组分。'}</div>
        </div>
      </Card>
    )
  }
  const merged = report.groups.filter((g) => g.merged)
  const refName = (id: string) => library.references.find((r) => r.id === id)?.short ?? id
  const slot = (id: string) => library.references.find((r) => r.id === id)?.slot ?? 1
  return (
    <Card
      title="可辨识性"
      aside={<span className="chip chip-muted">有效点 {report.wavelengthsUsed}</span>}
    >
      <div className="card-body stack">
        {merged.length === 0 ? (
          <Notice tone="good" icon="✓">
            当前候选集内所有组分都可单独辨识（扣除基线后最差成对相关 {worstPair(report.correlation).toFixed(3)}）。
          </Notice>
        ) : (
          <Notice tone="warn" icon="!">
            <strong>{merged.map((g) => g.memberIds.join(' + ')).join('、')}</strong> 扣除受限基线后方向近乎一致，
            数据只能确定它们的<strong>合计</strong>。结果区不会显示各成员的独立数值或区间。
          </Notice>
        )}
        <table className="data-table">
          <thead>
            <tr>
              <th>组</th>
              <th>成员</th>
              <th className="num">|r| 最大</th>
              <th className="num">κ</th>
            </tr>
          </thead>
          <tbody>
            {report.groups.map((g) => (
              <tr key={g.id}>
                <td>{g.id}</td>
                <td>
                  {g.memberIds.map((id) => (
                    <span key={id} className="row" style={{ display: 'inline-flex', gap: 4, marginRight: 8 }}>
                      <Swatch slot={slot(id)} />
                      {refName(id)}
                    </span>
                  ))}
                  {g.merged && <span className="chip chip-warn">只能合计</span>}
                  {g.baselineAbsorbed && <span className="chip chip-critical">被基线吸收</span>}
                </td>
                <td className="num">{g.memberIds.length > 1 ? g.maxCorr.toFixed(4) : '—'}</td>
                <td className="num">{Number.isFinite(g.condition) ? g.condition.toFixed(1) : '∞'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row-between">
          <span className="card-note">整体条件数 {Number.isFinite(report.condition) ? report.condition.toFixed(1) : '∞'}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpenHeat((v) => !v)}>
            {openHeat ? '收起相关矩阵' : '展开相关矩阵'}
          </button>
        </div>
        {openHeat && (
          <>
            <CorrelationHeatmap report={report} labels={wb.activeIds.map(refName)} />
            <p className="card-note">
              数值为扣除受限基线并按仪器噪声加权后的成对相关系数。接近 ±1 的单元意味着两者只差一个数值很小的方向，
              单独估计会把噪声放大成很大的不确定范围。
            </p>
          </>
        )}
      </div>
    </Card>
  )
}

function worstPair(corr: number[][]): number {
  let worst = 0
  for (let i = 0; i < corr.length; i++) {
    for (let j = i + 1; j < corr.length; j++) worst = Math.max(worst, Math.abs(corr[i][j]))
  }
  return worst
}

function CorrelationHeatmap({ report, labels }: { report: { correlation: number[][] }; labels: string[] }) {
  const k = labels.length
  const color = (v: number): string => {
    const a = Math.min(1, Math.abs(v))
    const hue = v >= 0 ? 'var(--accent)' : 'var(--series-2)'
    return `color-mix(in srgb, ${hue} ${(a * 80).toFixed(0)}%, var(--surface-1))`
  }
  return (
    <div className="heatmap" style={{ gridTemplateColumns: `auto repeat(${k}, minmax(0, 1fr))` }}>
      <span />
      {labels.map((l) => (
        <span key={`h-${l}`} className="muted small" style={{ textAlign: 'center' }}>
          {l}
        </span>
      ))}
      {labels.map((row, i) => (
        <FragmentRow key={`r-${row}`} label={row} values={report.correlation[i]} labels={labels} color={color} />
      ))}
    </div>
  )
}

function FragmentRow({
  label,
  values,
  labels,
  color,
}: {
  label: string
  values: number[]
  labels: string[]
  color: (v: number) => string
}) {
  return (
    <>
      <span className="muted small">{label}</span>
      {values.map((v, j) => (
        <span
          key={`${label}-${labels[j]}`}
          className="heat-cell mono"
          style={{ background: color(v), fontSize: 9.5 }}
          title={`${label} × ${labels[j]} = ${v.toFixed(4)}`}
        >
          {Math.abs(v) >= 0.9999 ? v.toFixed(3) : v.toFixed(2)}
        </span>
      ))}
    </>
  )
}

const STATUS_LABEL: Record<ConcentrationInterval['status'], string> = {
  identified: '已辨识',
  merged: '只能合计',
  undetected: '未检出',
  baseline: '基线吸收',
  masked: '区间作废',
}

function statusChip(status: ConcentrationInterval['status']) {
  const cls =
    status === 'identified' ? 'chip chip-good' : status === 'merged' ? 'chip chip-warn' : status === 'masked' || status === 'baseline' ? 'chip chip-critical' : 'chip chip-muted'
  return <span className={cls}>{STATUS_LABEL[status]}</span>
}

function ResultsCard() {
  const wb = useWorkbench()
  const s = wb.snapshot
  if (!s) {
    return (
      <Card title="解算结果">
        <div className="card-body">
          <div className="empty-block">尚未解算。确认左侧设置后点击“执行解算”。</div>
        </div>
      </Card>
    )
  }
  const stale = !wb.compatible
  return (
    <Card
      title="解算结果"
      aside={
        <span className={`chip ${stale ? 'chip-warn' : 'chip-good'}`}>{stale ? '旧结果' : '当前设置'}</span>
      }
    >
      <div className="card-body stack">
        {stale && (
          <Notice tone="warn" icon="!">
            以下数值对应的设置已改变（{wb.staleReasons.join('；')}）。它们保留为旧样本/旧参考的配套结果，请按当前设置重新解算后再引用。
          </Notice>
        )}
        <div className="stack" style={{ gap: 6 }}>
          {s.groupEstimates.map((g) => {
            const names = g.memberIds.map((id) => s.referenceNames[id] ?? id)
            const status = g.merged
              ? s.intervals[g.memberIds[0]]?.status ?? 'merged'
              : s.intervals[g.memberIds[0]]?.status ?? 'identified'
            return (
              <div key={g.groupId} className="row-between" style={{ alignItems: 'baseline' }}>
                <div className="row" style={{ gap: 6, minWidth: 0 }}>
                  <Swatch slot={s.referenceSlots[g.memberIds[0]] ?? 1} />
                  <span style={{ fontSize: 13 }}>
                    {g.merged ? names.map((n) => n.split(' ·')[0]).join(' + ') + '（合计）' : names[0]}
                  </span>
                  {statusChip(status)}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="conc-number">{formatNumber(g.value, 3)}</div>
                  {g.ci95 !== null ? (
                    <div className="conc-ci">± {formatNumber(g.ci95, 3)}（95%）</div>
                  ) : (
                    <div className="conc-ci">{cINote(g.merged, status)}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="divider" />
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">残差/噪声</div>
            <div className="stat-value sm">{(s.unexplainedRms / Math.max(s.noiseRms, 1e-9)).toFixed(1)}×</div>
          </div>
          <div className="stat">
            <div className="stat-label">χ²ν</div>
            <div className="stat-value sm">{s.chi2Reduced.toFixed(2)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">有效点</div>
            <div className="stat-value sm">{s.effectiveCount}</div>
          </div>
        </div>
        {s.notes.length > 0 && (
          <ul className="card-note" style={{ paddingLeft: 16, margin: 0 }}>
            {s.notes.map((note) => (
              <li key={note} style={{ marginBottom: 4 }}>
                {note}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function cINote(merged: boolean, status: ConcentrationInterval['status']): string {
  if (merged) return '只给合计，无区间'
  if (status === 'masked') return '峰区被屏蔽，区间作废'
  if (status === 'baseline') return '被基线吸收，无区间'
  if (status === 'undetected') return '未检出'
  return '无区间'
}

function HistoryCard() {
  const wb = useWorkbench()
  const entries = useMemo(() => wb.history.slice(0, 12), [wb.history])
  return (
    <Card
      title="历史结果"
      aside={
        wb.history.length > 0 ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={wb.clearHistory}>
            清空
          </button>
        ) : undefined
      }
    >
      <div className="card-body tight stack">
        {entries.length === 0 ? (
          <p className="card-note">换样、换库或改设置后再次解算时，旧结果会自动归档到这里，保留其当时的样本 + 参考库配对。</p>
        ) : (
          entries.map((e) => {
            const active = wb.snapshot?.id === e.fit.id
            return (
              <div key={e.fit.id} className={`history-item ${active ? 'is-active' : ''}`}>
                <div className="row-between">
                  <strong style={{ fontSize: 12.5 }}>{e.fit.sampleName}</strong>
                  <span className="chip chip-muted">{e.fit.libraryLabel}</span>
                </div>
                <div className="history-meta">
                  <span>{new Date(e.fit.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <span>{e.fit.mode === 'sparse' ? '稀疏' : '加权'}</span>
                  <span>{e.fit.activeReferenceIds.length} 组分</span>
                  <span>{e.fit.maskRanges.length} 屏蔽区</span>
                </div>
                <div className="history-meta">
                  <span>{e.reason}</span>
                </div>
                <div className="history-actions">
                  <button type="button" className="btn btn-sm" onClick={() => wb.viewHistory(e)}>
                    查看
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}

function DesignCard() {
  const wb = useWorkbench()
  const design = wb.live.design
  if (!design) return null
  const s = wb.snapshot
  const used = new Set(wb.calibIds)
  return (
    <Card title="设计摘要">
      <div className="card-body">
        <dl className="kv-list">
          <div className="kv">
            <dt>有效波长点</dt>
            <dd>{design.indices.length}</dd>
          </div>
          <div className="kv">
            <dt>候选组分 / 基线系数</dt>
            <dd>
              {design.activeIds.length} / {design.baselineColumns.length}
            </dd>
          </div>
          <div className="kv">
            <dt>自由度</dt>
            <dd>{Math.max(1, design.y.length - design.degreeOfFreedom)}</dd>
          </div>
          <div className="kv">
            <dt>噪声中位数</dt>
            <dd>{formatNumber(design.noiseMedian, 4)}</dd>
          </div>
          <div className="kv">
            <dt>噪声来源</dt>
            <dd>{design.noiseSource === 'replicates' ? '重复测量 SD' : '二阶差分稳健估计'}</dd>
          </div>
          <div className="kv">
            <dt>选参标定样</dt>
            <dd>{used.size ? [...used].join('、') : '未选择'}</dd>
          </div>
          {s && (
            <div className="kv">
              <dt>基线漂移（解算后）</dt>
              <dd>{formatSigned(Math.max(...s.baseline) - Math.min(...s.baseline), 3)}</dd>
            </div>
          )}
        </dl>
      </div>
    </Card>
  )
}
