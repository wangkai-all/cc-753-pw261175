import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { linearScale, niceTicks, formatNumber } from '../lib/chart'

export interface ChartSeries {
  id: string
  label: string
  values: number[]
  color: string
  width?: number
  dash?: string
  opacity?: number
  area?: boolean
  visible?: boolean
}

export interface ChartVBand {
  id: string
  from: number
  to: number
  label?: string
  tone: 'mask' | 'selection' | 'signal'
}

export interface ChartDot {
  x: number
  y: number
  color: string
  label: string
}

interface ChartProps {
  x: number[]
  series: ChartSeries[]
  height?: number
  yLabel?: string
  xLabel?: string
  bands?: ChartVBand[]
  dots?: ChartDot[]
  yDomain?: [number, number]
  zeroLine?: boolean
  onBrushEnd?: (from: number, to: number) => void
  brushEnabled?: boolean
  emptyMessage?: string
  summary?: string
}

const MARGIN = { top: 14, right: 18, bottom: 34, left: 56 }

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        if (w > 0) setWidth(w)
      }
    })
    observer.observe(el)
    setWidth(el.getBoundingClientRect().width || 720)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export function Chart({
  x,
  series,
  height = 280,
  yLabel,
  xLabel = '波长 / nm',
  bands = [],
  dots = [],
  yDomain,
  zeroLine = false,
  onBrushEnd,
  brushEnabled = false,
  emptyMessage,
  summary,
}: ChartProps) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>()
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const visible = series.filter((s) => s.visible !== false)
  const innerW = Math.max(80, width - MARGIN.left - MARGIN.right)
  const innerH = Math.max(60, height - MARGIN.top - MARGIN.bottom)

  const xDomain: [number, number] = x.length ? [x[0], x[x.length - 1]] : [0, 1]
  const yVals = visible.flatMap((s) => s.values).filter((v) => Number.isFinite(v))
  const computedY: [number, number] = yDomain ?? (() => {
    if (yVals.length === 0) return [-1, 1]
    let lo = Math.min(...yVals)
    let hi = Math.max(...yVals)
    if (lo === hi) {
      lo -= 0.5
      hi += 0.5
    }
    const pad = (hi - lo) * 0.08
    return [lo - pad, hi + pad]
  })()

  const xScale = useMemo(() => linearScale(xDomain, [MARGIN.left, MARGIN.left + innerW]), [xDomain[0], xDomain[1], innerW])
  const yScale = useMemo(() => linearScale(computedY, [MARGIN.top + innerH, MARGIN.top]), [computedY[0], computedY[1], innerH])

  const xTicks = useMemo(() => niceTicks(xDomain[0], xDomain[1], Math.max(3, Math.floor(innerW / 90))), [xDomain[0], xDomain[1], innerW])
  const yTicks = useMemo(() => niceTicks(computedY[0], computedY[1], Math.max(3, Math.floor(innerH / 46))), [computedY[0], computedY[1], innerH])

  const pointFromEvent = useCallback(
    (event: React.PointerEvent<SVGSVGElement>): number | null => {
      const svg = svgRef.current
      if (!svg || x.length === 0) return null
      const rect = svg.getBoundingClientRect()
      const px = ((event.clientX - rect.left) / rect.width) * width
      const wx = xScale.invert(px)
      let best = 0
      let bestDist = Infinity
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - wx)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      return best
    },
    [x, xScale, width],
  )

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!brushEnabled || !onBrushEnd) return
    const idx = pointFromEvent(event)
    if (idx === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setBrush({ a: idx, b: idx })
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const idx = pointFromEvent(event)
    if (idx === null) return
    setHoverIndex(idx)
    if (brush) setBrush((prev) => (prev ? { ...prev, b: idx } : null))
  }

  const finishBrush = (event: React.PointerEvent<SVGSVGElement>) => {
    if (brush && onBrushEnd) {
      const lo = Math.min(brush.a, brush.b)
      const hi = Math.max(brush.a, brush.b)
      if (hi > lo) onBrushEnd(x[lo], x[hi])
    }
    setBrush(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const plotBottom = MARGIN.top + innerH
  const plotRight = MARGIN.left + innerW

  const brushBand = useMemo(() => {
    if (!brush) return null
    const lo = Math.min(brush.a, brush.b)
    const hi = Math.max(brush.a, brush.b)
    return { from: x[lo], to: x[hi], x0: xScale.map(x[lo]), x1: xScale.map(x[hi]) }
  }, [brush, x, xScale])

  const hover = hoverIndex !== null && x[hoverIndex] !== undefined ? hoverIndex : null

  const tableRows = useMemo(() => {
    const counts = [0, Math.floor(x.length / 2), x.length - 1].filter((i) => i >= 0 && i < x.length)
    return counts.map((i) => ({ x: x[i], values: visible.map((s) => ({ label: s.label, value: s.values[i], color: s.color })) }))
  }, [x, visible])

  if (x.length === 0) {
    return <div className="chart-empty">{emptyMessage ?? '没有可绘制的数据。'}</div>
  }

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="chart-caption-row">
        <span className="chart-axis-label">{yLabel}</span>
        {summary && <span className="chart-summary">{summary}</span>}
      </div>
      <svg
        ref={svgRef}
        className={`chart ${brushEnabled ? 'is-brushable' : ''}`}
        width={width}
        height={height}
        role="img"
        aria-label={`${yLabel ?? '光谱'} 随 ${xLabel} 变化，共 ${x.length} 个波长点。`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishBrush}
        onPointerLeave={() => {
          setHoverIndex(null)
          setBrush(null)
        }}
        tabIndex={0}
        onKeyDown={(e) => {
          if (hover === null) {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') setHoverIndex(0)
            return
          }
          if (e.key === 'ArrowRight') {
            setHoverIndex(Math.min(x.length - 1, hover + 1))
            e.preventDefault()
          } else if (e.key === 'ArrowLeft') {
            setHoverIndex(Math.max(0, hover - 1))
            e.preventDefault()
          } else if (e.key === 'Escape') setHoverIndex(null)
        }}
      >
        {bands.map((band) => (
          <rect
            key={band.id}
            x={Math.max(MARGIN.left, xScale.map(band.from))}
            y={MARGIN.top}
            width={Math.max(0, Math.min(plotRight, xScale.map(band.to)) - Math.max(MARGIN.left, xScale.map(band.from)))}
            height={innerH}
            className={`band band-${band.tone}`}
          />
        ))}
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line
              x1={MARGIN.left}
              x2={plotRight}
              y1={yScale.map(tick)}
              y2={yScale.map(tick)}
              className="grid-line"
            />
            <text x={MARGIN.left - 8} y={yScale.map(tick)} className="axis-text" textAnchor="end" dominantBaseline="middle">
              {formatNumber(tick, 2)}
            </text>
          </g>
        ))}
        {zeroLine && yScale.domain[0] < 0 && yScale.domain[1] > 0 && (
          <line x1={MARGIN.left} x2={plotRight} y1={yScale.map(0)} y2={yScale.map(0)} className="zero-line" />
        )}
        <line x1={MARGIN.left} x2={plotRight} y1={plotBottom} y2={plotBottom} className="axis-line" />
        <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={plotBottom} className="axis-line" />
        {xTicks.map((tick) => (
          <text
            key={`x${tick}`}
            x={xScale.map(tick)}
            y={plotBottom + 18}
            className="axis-text"
            textAnchor="middle"
          >
            {tick}
          </text>
        ))}
        <text x={MARGIN.left + innerW / 2} y={height - 2} className="axis-text axis-title" textAnchor="middle">
          {xLabel}
        </text>

        {visible.map((s) => {
          const pts: [number, number][] = []
          for (let i = 0; i < x.length; i++) {
            const v = s.values[i]
            if (!Number.isFinite(v)) continue
            pts.push([xScale.map(x[i]), yScale.map(v)])
          }
          if (pts.length === 0) return null
          const path = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ')
          const fill =
            s.area && pts.length > 1
              ? `${path} L${pts[pts.length - 1][0].toFixed(2)},${yScale.map(Math.max(yScale.domain[0], 0)).toFixed(2)} L${pts[0][0].toFixed(2)},${yScale.map(Math.max(yScale.domain[0], 0)).toFixed(2)} Z`
              : null
          return (
            <g key={s.id}>
              {fill && <path d={fill} fill={s.color} opacity={s.opacity ?? 0.12} stroke="none" />}
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width ?? 2}
                strokeDasharray={s.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={s.opacity ?? 1}
              />
            </g>
          )
        })}

        {dots.map((dot) => (
          <g key={`${dot.label}-${dot.x}-${dot.y}`}>
            <circle cx={xScale.map(dot.x)} cy={yScale.map(dot.y)} r={4} fill={dot.color} stroke="var(--surface-1)" strokeWidth={2}>
              <title>{dot.label}</title>
            </circle>
          </g>
        ))}

        {brushBand && (
          <rect
            x={Math.min(brushBand.x0, brushBand.x1)}
            y={MARGIN.top}
            width={Math.max(1, Math.abs(brushBand.x1 - brushBand.x0))}
            height={innerH}
            className="band band-selecting"
          />
        )}

        {hover !== null && (
          <g>
            <line
              x1={xScale.map(x[hover])}
              x2={xScale.map(x[hover])}
              y1={MARGIN.top}
              y2={plotBottom}
              className="crosshair"
            />
            {visible.map((s) => {
              const v = s.values[hover]
              if (!Number.isFinite(v)) return null
              return (
                <circle
                  key={`h-${s.id}`}
                  cx={xScale.map(x[hover])}
                  cy={yScale.map(v)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              )
            })}
          </g>
        )}
      </svg>

      {brushEnabled && <p className="chart-hint">在图上拖动可圈选波长区间。</p>}

      {hover !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(MARGIN.left + 8, xScale.map(x[hover]) + 12), Math.max(MARGIN.left + 8, width - 190)),
            top: MARGIN.top + 6,
          }}
        >
          <div className="tooltip-x">{x[hover].toFixed(1)} nm</div>
          {visible.map((s) => (
            <div className="tooltip-row" key={s.id}>
              <span className="tooltip-key" style={{ background: s.color }} />
              <span className="tooltip-value">{formatNumber(s.values[hover], 4)}</span>
              <span className="tooltip-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="legend-row">
        {visible.map((s) => (
          <span className="legend-item" key={s.id}>
            <span className={`legend-swatch ${s.dash ? 'is-dashed' : ''}`} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <details className="table-view">
        <summary>表格视图</summary>
        <table>
          <thead>
            <tr>
              <th>{xLabel}</th>
              {visible.map((s) => (
                <th key={s.id}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row) => (
              <tr key={row.x}>
                <td>{row.x.toFixed(1)}</td>
                {row.values.map((v) => (
                  <td key={v.label}>{formatNumber(v.value as number, 4)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">仅列出首、中、末三个波长点；悬停可查看任意点。</p>
      </details>
    </div>
  )
}
