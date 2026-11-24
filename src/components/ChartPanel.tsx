import { useMemo, useState } from 'react'
import { useWorkbench } from '../state'
import { Chart } from './Chart'
import type { ChartDot, ChartSeries, ChartVBand } from './Chart'
import { Card, Notice, Stat, Swatch } from './ui'
import { formatNumber, formatSigned, formatWavelength } from '../lib/chart'
import { audit } from '../lib/calibration'
import { baselineDrift } from '../lib/baseline'

function slotColor(slot: number): string {
  return `var(--series-${Math.min(8, Math.max(1, slot))})`
}

export function ChartPanel() {
  const wb = useWorkbench()
  const { snapshot, live, dataset } = wb
  const x = snapshot?.wavelength ?? live.design?.wavelength ?? []
  const [showTruth, setShowTruth] = useState(false)

  const bands: ChartVBand[] = useMemo(() => {
    const list: ChartVBand[] = []
    for (const m of wb.masks) list.push({ id: `mask-${m.id}`, from: m.from, to: m.to, tone: 'mask' })
    for (const b of snapshot?.bands ?? []) {
      list.push({ id: `sig-${b.from}`, from: b.from, to: b.to, tone: 'signal' })
    }
    return list
  }, [wb.masks, snapshot])

  const baseSeries: ChartSeries[] = useMemo(() => {
    const series: ChartSeries[] = []
    if (live.design) {
      series.push({
        id: 'mixture',
        label: '混合谱（当前窗口）',
        values: live.design.y,
        color: 'var(--text-muted)',
        width: 1.25,
        opacity: 0.85,
      })
    }
    if (snapshot) {
      series.push({ id: 'fitted', label: '联合拟合', values: snapshot.fitted, color: 'var(--accent)', width: 2 })
      series.push({
        id: 'baseline',
        label: '受限基线',
        values: snapshot.baseline,
        color: 'var(--series-5)',
        width: 2,
        dash: '5 3',
      })
    }
    return series
  }, [live.design, snapshot])

  const dots: ChartDot[] = useMemo(() => {
    if (!snapshot) return []
    return snapshot.badPoints.map((p) => ({
      x: p.wavelength,
      y: snapshot.sampleValues[snapshot.wavelength.indexOf(p.wavelength)] ?? 0,
      color: 'var(--critical)',
      label: `局部坏点 ${formatWavelength(p.wavelength)} nm，残差 ${formatSigned(p.residual)}，局部偏离 ${formatSigned(p.z, 1)}σ`,
    }))
  }, [snapshot])

  const contributionSeries: ChartSeries[] = useMemo(() => {
    if (!snapshot) return []
    return snapshot.groupEstimates
      .filter((g) => g.value > 0 || g.merged)
      .map((g) => ({
        id: `g-${g.groupId}`,
        label: g.memberIds
          .map((id) => snapshot.referenceNames[id]?.split(' ·')[0] ?? id)
          .join(' + '),
        values: snapshot.groupContributions[g.groupId] ?? [],
        color: slotColor(snapshot.referenceSlots[g.memberIds[0]] ?? 1),
        width: 1.75,
      }))
  }, [snapshot])

  const onBrush = (from: number, to: number) => {
    if (wb.brushMode === 'mask') wb.addMask(from, to)
    else wb.setValidRange([from, to])
  }

  const summary = snapshot
    ? `残差 RMS ${formatNumber(snapshot.unexplainedRms, 4)} · 噪声 ${formatNumber(snapshot.noiseRms, 4)} · χ²ν ${snapshot.chi2Reduced.toFixed(2)}`
    : undefined

  return (
    <div className="column rail-center">
      <Card
        title="混合光谱与联合拟合"
        aside={
          snapshot ? (
            <span className={`chip ${wb.compatible ? 'chip-good' : 'chip-warn'}`}>
              {wb.compatible ? '当前设置' : '旧解算结果'}
            </span>
          ) : (
            <span className="chip chip-muted">尚未解算</span>
          )
        }
      >
        <div className="card-body">
          <Chart
            x={x}
            series={baseSeries}
            bands={bands}
            dots={dots}
            height={320}
            yLabel={`强度 / ${dataset.unit}`}
            brushEnabled
            onBrushEnd={onBrush}
            zeroLine
            summary={summary}
            emptyMessage="没有可用的波长点。请放宽有效区或减少屏蔽区。"
          />
          <p className="chart-hint">
            灰色竖带为屏蔽区，红色带为模型无法解释的残差区间；红点为孤立尖峰（局部坏点）。
            {wb.brushMode === 'mask' ? '当前圈选模式：屏蔽峰区。' : '当前圈选模式：设为有效区。'}
          </p>
        </div>
      </Card>

      <Card title="残差" aside={<span className="chart-summary">±3.2σ 以外标为未解释区间</span>}>
        <div className="card-body">
          {snapshot ? (
            <Chart
              x={snapshot.wavelength}
              series={[
                {
                  id: 'residual',
                  label: '残差（数据 − 拟合）',
                  values: snapshot.residual,
                  color: 'var(--series-8)',
                  width: 1.5,
                },
                {
                  id: 'noise',
                  label: '噪声参考 ±1σ',
                  values: snapshot.residual.map(() => snapshot.noiseRms),
                  color: 'var(--text-muted)',
                  width: 1,
                  dash: '3 3',
                  opacity: 0.7,
                },
                {
                  id: 'noise-neg',
                  label: '−1σ',
                  values: snapshot.residual.map(() => -snapshot.noiseRms),
                  color: 'var(--text-muted)',
                  width: 1,
                  dash: '3 3',
                  opacity: 0.7,
                },
              ]}
              bands={bands.filter((b) => b.tone !== 'mask')}
              height={190}
              yLabel="残差"
              zeroLine
            />
          ) : (
            <div className="empty-block">解算后显示残差。</div>
          )}
        </div>
      </Card>

      <Card
        title="组分贡献"
        aside={
          snapshot ? (
            <span className="legend-note">{contributionSeries.length} 条曲线（合并组只画合计）</span>
          ) : undefined
        }
      >
        <div className="card-body">
          {snapshot && contributionSeries.length > 0 ? (
            <>
              <Chart
                x={snapshot.wavelength}
                series={[
                  ...contributionSeries,
                  {
                    id: 'baseline',
                    label: '基线',
                    values: snapshot.baseline,
                    color: 'var(--series-5)',
                    width: 1.25,
                    dash: '5 3',
                    opacity: 0.8,
                  },
                ]}
                height={230}
                yLabel="贡献强度"
                zeroLine
              />
              <div className="legend-row">
                {snapshot.groupEstimates.map((g) => (
                  <span className="legend-item" key={g.groupId}>
                    <Swatch slot={snapshot.referenceSlots[g.memberIds[0]] ?? 1} line />
                    {g.memberIds.join(' + ')}：
                    <strong className="mono">{formatNumber(g.value, 3)}</strong>
                    {g.merged && <span className="chip chip-warn">合计</span>}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-block">解算后显示各组分对混合谱的贡献。</div>
          )}
        </div>
      </Card>

      <UnexplainedPanel />

      <AuditPanel showTruth={showTruth} setShowTruth={setShowTruth} />
    </div>
  )
}

function UnexplainedPanel() {
  const wb = useWorkbench()
  const s = wb.snapshot
  if (!s) return null
  const ratio = s.unexplainedRms / Math.max(s.noiseRms, 1e-9)
  const contaminant = wb.dataset.contaminant
  return (
    <Card title="不能解释的信号" aside={<span className="chip chip-muted">{s.bands.length} 个区间</span>}>
      <div className="card-body stack">
        {ratio > 2 ? (
          <Notice tone="warn" icon="!">
            残差 RMS 是噪声水平的 <strong>{ratio.toFixed(1)} 倍</strong>。模型只能解释参考库中已有的组分与受限基线，
            其余结构被视为“不能解释的信号”，不强行归给任何组分。
          </Notice>
        ) : (
          <Notice tone="good" icon="✓">
            残差 RMS 为噪声水平的 {ratio.toFixed(1)} 倍，未发现明显的模型外结构。
          </Notice>
        )}
        {s.bands.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>波长区间 / nm</th>
                <th className="num">峰值残差</th>
                <th className="num">积分</th>
              </tr>
            </thead>
            <tbody>
              {s.bands.map((b) => (
                <tr key={`${b.from}-${b.to}`}>
                  <td>
                    {formatWavelength(b.from)} – {formatWavelength(b.to)}（峰 {formatWavelength(b.peakWavelength)}）
                  </td>
                  <td className="num">{formatSigned(b.peakResidual, 3)}</td>
                  <td className="num">{formatSigned(b.integrated, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="card-note">没有超过 3.2σ 噪声阈值的连续残差区间。</p>
        )}
        {s.badPoints.length > 0 && (
          <div>
            <div className="section-title">局部坏点（{s.badPoints.length}）</div>
            <div className="pill-row">
              {s.badPoints.map((p) => (
                <span className="chip chip-critical" key={`${p.index}`}>
                  {formatWavelength(p.wavelength)} nm · 局部 {formatSigned(p.z, 1)}σ
                </span>
              ))}
            </div>
            <p className="card-note" style={{ marginTop: 6 }}>
              坏点与未解释峰区会拉高残差；如需得到更稳的组分区间，可在左侧圈选屏蔽这些波长后重新解算。
            </p>
          </div>
        )}
        {contaminant && (
          <p className="card-note">
            内置污染参考 <strong>{contaminant.name}</strong>（{contaminant.note}）不参与拟合。它的窄线若出现在未解释区间，
            说明样品中存在参考库以外的成分——这正是残差不为零的物理来源。
          </p>
        )}
      </div>
    </Card>
  )
}

function AuditPanel({ showTruth, setShowTruth }: { showTruth: boolean; setShowTruth: (v: boolean) => void }) {
  const wb = useWorkbench()
  const s = wb.snapshot
  const dataset = wb.dataset
  const result = useMemo(() => (s ? audit(s, dataset) : null), [s, dataset])
  if (!s || !result) return null
  const hasTruth = result.truthAvailable
  const sample = dataset.samples.find((x) => x.id === s.sampleId)
  const drift = baselineDrift(s.baseline)
  return (
    <Card
      title="恢复误差核对"
      aside={
        hasTruth ? (
          <button type="button" className="btn btn-sm" onClick={() => setShowTruth(!showTruth)}>
            {showTruth ? '隐藏真值' : '显示真值'}
          </button>
        ) : (
          <span className="chip chip-muted">该样品无真值</span>
        )
      }
    >
      <div className="card-body stack">
        <p className="card-note">
          核对只在解算完成后进行，解算器从不读取真值。比较的是<strong>可辨识的合计值</strong>与已知混合比例，
          并在合并组处合并真值。
        </p>
        {!hasTruth ? (
          <p className="card-note">导入的数据未提供真值，无法给出恢复误差。</p>
        ) : !showTruth ? (
          <div className="empty-block">真值默认隐藏，点击右上角“显示真值”核对恢复误差。</div>
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>可辨识量</th>
                  <th className="num">估计</th>
                  <th className="num">真值</th>
                  <th className="num">误差</th>
                  <th className="num">相对</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.quantityId}>
                    <td>
                      {row.label}
                      {row.merged && <span className="chip chip-warn" style={{ marginLeft: 6 }}>合计</span>}
                    </td>
                    <td className="num">{formatNumber(row.estimate, 3)}</td>
                    <td className="num">{formatNumber(row.truth, 3)}</td>
                    <td className="num">{formatSigned(row.absError, 3)}</td>
                    <td className="num is-muted">
                      {row.relError === null ? '—' : `${(row.relError * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="stat-grid">
              <Stat label="合计绝对误差" value={formatNumber(result.totalAbsError, 3)} small />
              <Stat label="真值合计" value={formatNumber(result.totalTruth, 3)} small />
              <Stat label="基线漂移" value={formatNumber(drift, 3)} small />
              <Stat
                label="基线拟合偏差"
                value={result.baselineRms === null ? '—' : formatNumber(result.baselineRms, 4)}
                small
              />
            </div>
            {result.unmodeled.length > 0 && (
              <Notice tone="warn" icon="!">
                样品真值含未建模组分：
                {result.unmodeled.map((u) => `${u.name} ≈ ${formatNumber(u.truth, 2)}`).join('、')}。
                它们不在候选库中，其信号被归入“不能解释的信号”，会抬高相关组分的估计误差。
              </Notice>
            )}
            {result.contaminantRms !== null && (
              <p className="card-note">
                残差在污染参考上的投影幅度 ≈ <strong>{formatNumber(result.contaminantRms, 3)}</strong>
                （真值 {formatNumber(sample?.contaminantTruth ?? 0, 3)}）。这是“指示值”而非精确回收：污染谱与其它组分部分重叠，
                投影会低估真实含量；它的价值在于提示污染存在与量级，而不是给出组分浓度。
              </p>
            )}
          </>
        )}
        <details className="table-view">
          <summary>本次解算的设计摘要</summary>
          <table>
            <tbody>
              <tr>
                <td>有效波长点</td>
                <td className="num">{s.effectiveCount}</td>
              </tr>
              <tr>
                <td>基线阶数 / 系数上限</td>
                <td className="num">
                  {s.baselineDegree} / ±{s.baselineBound.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td>正则参数</td>
                <td className="num">
                  λb {formatNumber(s.lambdaBase, 4)} · λ₁ {formatNumber(s.lambdaL1, 4)}
                </td>
              </tr>
              <tr>
                <td>R²</td>
                <td className="num">{formatNumber(1 - s.ssResidual / Math.max(s.ssTotal, 1e-20), 5)}</td>
              </tr>
              <tr>
                <td>条件数</td>
                <td className="num">{formatNumber(s.condition, 1)}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </Card>
  )
}
