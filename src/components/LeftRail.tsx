import { useWorkbench } from '../state'
import { formatLambda } from '../lib/chart'
import { Card, Field, Notice, Seg, Swatch } from './ui'
import { IDENT_CORR_THRESHOLD, IDENT_CONDITION_THRESHOLD } from '../lib/design'

function formatW(v: number): string {
  return Number.isInteger(v) ? `${v}` : v.toFixed(1)
}

export function LeftRail() {
  const wb = useWorkbench()
  const { dataset, library, sample } = wb
  const refs = library?.references ?? []
  const calibSamples = dataset.samples.filter((s) => s.kind === 'calibration')

  return (
    <div className="column rail-left">
      <div className="card">
        <div className="card-body">
          <div className="row-between wrap" style={{ gap: 10 }}>
            <div>
              <div className="section-title" style={{ marginBottom: 2 }}>
                {wb.compatible ? '当前设置已解算' : wb.snapshot ? '设置已改变，结果待更新' : '尚未解算'}
              </div>
              <p className="card-note">
                {sample?.name ?? '—'} · {library?.label ?? '—'} · {wb.activeIds.length} 个候选组分
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={wb.solveNow}>
              执行解算
            </button>
          </div>
          {wb.solveError && (
            <div style={{ marginTop: 8 }}>
              <Notice tone="critical" icon="!">
                {wb.solveError}
              </Notice>
            </div>
          )}
          {wb.live.error && (
            <div style={{ marginTop: 8 }}>
              <Notice tone="warn" icon="!">
                {wb.live.error}
              </Notice>
            </div>
          )}
        </div>
      </div>
      <Card
        title="数据与样品"
        aside={<span className="chip chip-muted">{dataset.source === 'builtin' ? '内置虚构数据' : '已导入'}</span>}
      >
        <div className="card-body stack">
          <Field label="参考库" hint="更换后重新判定可辨识性">
            <select value={wb.libraryId} onChange={(e) => wb.setLibrary(e.target.value)} aria-label="参考库">
              {dataset.libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.label}（{lib.references.length} 组分）
                </option>
              ))}
            </select>
          </Field>
          {library && <p className="card-note">{library.note}</p>}
          <Field label="样品" hint={`${dataset.samples.length} 个`}>
            <select value={wb.sampleId} onChange={(e) => wb.setSample(e.target.value)} aria-label="样品">
              {(['calibration', 'validation', 'unknown'] as const).map((kind) => {
                const group = dataset.samples.filter((s) => s.kind === kind)
                if (!group.length) return null
                return (
                  <optgroup key={kind} label={kind === 'calibration' ? '标定样' : kind === 'validation' ? '验证样' : '未知样'}>
                    {group.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
          </Field>
          {sample && <p className="card-note">{sample.note}</p>}
        </div>
      </Card>

      <Card
        title="候选组分"
        aside={
          <div className="row">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => wb.setAllActive(true)}>
              全选
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => wb.setAllActive(false)}>
              清空
            </button>
          </div>
        }
      >
        <div className="card-body tight stack">
          {refs.map((ref) => {
            const on = wb.activeIds.includes(ref.id)
            const group = wb.live.report?.groups.find((g) => g.memberIds.includes(ref.id))
            const merged = group?.merged
            return (
              <label key={ref.id} className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => wb.toggleActive(ref.id)}
                  aria-label={`${ref.name} 作为候选组分`}
                />
                <span className="check-body">
                  <span className="check-title">
                    <Swatch slot={ref.slot} />
                    {ref.short}
                    {on && merged && <span className="chip chip-warn">合并估计</span>}
                  </span>
                  <span className="check-sub">{ref.note ?? ref.name}</span>
                </span>
              </label>
            )
          })}
          {refs.length === 0 && <p className="card-note">该参考库没有可用参考谱。</p>}
          <p className="card-note">
            候选集变化会即时重算可辨识性。相关阈值 |r| ≥ {IDENT_CORR_THRESHOLD}、条件数 ≥ {IDENT_CONDITION_THRESHOLD}
            （扣除基线后）的组分被归为同一组，只报告合计。
          </p>
        </div>
      </Card>

      <Card title="波长窗口与屏蔽">
        <div className="card-body stack">
          <div className="row-between">
            <span className="section-title" style={{ margin: 0 }}>
              有效波长区
            </span>
            <span className="range-display">
              {formatW(wb.validRange[0])} – {formatW(wb.validRange[1])} nm
            </span>
          </div>
          <RangeSlider
            value={wb.validRange}
            min={dataset.wavelength[0]}
            max={dataset.wavelength[dataset.wavelength.length - 1]}
            onChange={wb.setValidRange}
          />
          <div className="divider" />
          <div className="row-between">
            <span className="section-title" style={{ margin: 0 }}>
              圈选用途
            </span>
            <Seg
              ariaLabel="圈选用途"
              value={wb.brushMode}
              onChange={wb.setBrushMode}
              options={[
                { value: 'mask', label: '屏蔽峰区' },
                { value: 'window', label: '设为有效区' },
              ]}
            />
          </div>
          <p className="card-note">在中间光谱图上拖动即可圈选。屏蔽峰区会立即作废该组分原有的不确定范围。</p>
          {wb.masks.length === 0 ? (
            <p className="card-note">尚无屏蔽区。局部坏点或溶剂干扰可圈选屏蔽。</p>
          ) : (
            <div className="mask-list">
              {wb.masks.map((m) => (
                <div key={m.id} className="mask-item">
                  <span className="chip chip-muted">屏蔽</span>
                  <span className="range-display">
                    {formatW(m.from)} – {formatW(m.to)} nm
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost btn-danger"
                    onClick={() => wb.removeMask(m.id ?? '')}
                    aria-label={`删除 ${formatW(m.from)}–${formatW(m.to)} nm 屏蔽区`}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-sm btn-ghost" onClick={wb.clearMasks}>
                清除全部屏蔽区
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card title="拟合设置">
        <div className="card-body stack">
          <Field label="拟合模式">
            <Seg
              ariaLabel="拟合模式"
              value={wb.mode}
              onChange={wb.setMode}
              options={[
                { value: 'weighted', label: '噪声加权' },
                { value: 'sparse', label: '稀疏（L1）' },
              ]}
            />
          </Field>
          <Field label="加权方式" hint={wb.weighting === 'noise' ? '按每通道噪声方差' : '等权'}>
            <Seg
              ariaLabel="加权方式"
              value={wb.weighting}
              onChange={wb.setWeighting}
              options={[
                { value: 'noise', label: '按噪声' },
                { value: 'uniform', label: '等权' },
              ]}
            />
          </Field>
          <div className="field">
            <label>
              <span>基线多项式阶数</span>
              <span className="muted small">{wb.degree}</span>
            </label>
            <input
              type="range"
              min={1}
              max={7}
              step={1}
              value={wb.degree}
              onChange={(e) => wb.setDegree(Number(e.target.value))}
              aria-label="基线多项式阶数"
            />
          </div>
          <div className="field">
            <label>
              <span>基线系数上限 ±</span>
              <span className="muted small">{wb.bound.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={0.2}
              max={6}
              step={0.1}
              value={wb.bound}
              onChange={(e) => wb.setBound(Number(e.target.value))}
              aria-label="基线系数上限"
            />
          </div>
          <div className="row" style={{ gap: 10 }}>
            <NumberField
              label="λ 基线"
              value={wb.lambdaBase}
              onChange={wb.setLambdaBase}
              step={0.0005}
              min={0}
              help={formatLambda(wb.lambdaBase)}
            />
            <NumberField
              label="λ₁ 稀疏"
              value={wb.lambdaL1}
              onChange={wb.setLambdaL1}
              step={0.005}
              min={0}
              help={formatLambda(wb.lambdaL1)}
              disabled={wb.mode !== 'sparse'}
            />
          </div>
          <p className="card-note">两个正则参数都按相对尺度定义，可从独立标定样自动挑选。</p>
        </div>
      </Card>

      <Card
        title="标定选参"
        aside={<span className="chip chip-muted">{wb.calibIds.length} 个标定样</span>}
      >
        <div className="card-body tight stack">
          {calibSamples.length === 0 ? (
            <p className="card-note">数据集中没有标定样，只能手动设定正则参数。</p>
          ) : (
            calibSamples.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={wb.calibIds.includes(s.id)}
                  onChange={() => wb.toggleCalib(s.id)}
                  aria-label={`使用 ${s.name} 选参`}
                />
                <span className="check-body">
                  <span className="check-title">{s.name}</span>
                  <span className="check-sub">{s.note}</span>
                </span>
              </label>
            ))
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={wb.runTuning}
            disabled={wb.calibIds.length === 0}
          >
            从标定样挑选正则参数
          </button>
          {wb.tuning && <TuningSummary />}
        </div>
      </Card>

    </div>
  )
}

function RangeSlider({
  value,
  min,
  max,
  onChange,
}: {
  value: [number, number]
  min: number
  max: number
  onChange: (range: [number, number]) => void
}) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value[0]}
        aria-label="有效区起始波长"
        onChange={(e) => onChange([Math.min(Number(e.target.value), value[1] - 4), value[1]])}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value[1]}
        aria-label="有效区结束波长"
        onChange={(e) => onChange([value[0], Math.max(Number(e.target.value), value[0] + 4)])}
      />
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  help,
  disabled,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step: number
  min: number
  help?: string
  disabled?: boolean
}) {
  return (
    <div className="field" style={{ flex: 1 }}>
      <label>
        <span>{label}</span>
        {help && <span className="muted small">{help}</span>}
      </label>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v >= min) onChange(v)
        }}
      />
    </div>
  )
}

function TuningSummary() {
  const wb = useWorkbench()
  const t = wb.tuning
  if (!t) return null
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Notice tone={t.feasible ? 'good' : 'warn'} icon={t.feasible ? '✓' : '!'}>
        {t.note}
      </Notice>
      {t.basePath.length > 0 && (
        <details className="table-view" open>
          <summary>基线正则路径（独立标定样均分）</summary>
          <table>
            <thead>
              <tr>
                <th>λ 基线</th>
                <th>组分误差均分</th>
              </tr>
            </thead>
            <tbody>
              {t.basePath.map((p) => (
                <tr key={p.lambda} className={p.lambda === t.lambdaBase ? 'is-active' : ''}>
                  <td>{formatLambda(p.lambda)}</td>
                  <td>{p.score.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {t.l1Path.length > 0 && (
        <details className="table-view">
          <summary>L1 正则路径</summary>
          <table>
            <thead>
              <tr>
                <th>λ₁</th>
                <th>误差均分</th>
                <th>非零组分</th>
              </tr>
            </thead>
            <tbody>
              {t.l1Path.map((p) => (
                <tr key={p.lambda} className={p.lambda === t.lambdaL1 ? 'is-active' : ''}>
                  <td>{formatLambda(p.lambda)}</td>
                  <td>{p.score.toFixed(4)}</td>
                  <td>{p.activeCount.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}
