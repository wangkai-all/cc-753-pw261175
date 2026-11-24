export interface Scale {
  domain: [number, number]
  range: [number, number]
  map: (v: number) => number
  invert: (p: number) => number
  clamp: (v: number) => number
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1
  const map = (v: number) => r0 + ((v - d0) / span) * (r1 - r0)
  const invert = (p: number) => d0 + ((p - r0) / (r1 - r0 || 1)) * span
  return {
    domain,
    range,
    map,
    invert,
    clamp: (v: number) => Math.max(Math.min(d0, d1), Math.min(Math.max(d0, d1), v)),
  }
}

export function logScale(domain: [number, number], range: [number, number]): Scale {
  const d0 = Math.log10(Math.max(domain[0], 1e-12))
  const d1 = Math.log10(Math.max(domain[1], 1e-11))
  const [r0, r1] = range
  const span = d1 - d0 || 1
  const map = (v: number) => r0 + ((Math.log10(Math.max(v, 1e-12)) - d0) / span) * (r1 - r0)
  const invert = (p: number) => 10 ** (d0 + ((p - r0) / (r1 - r0 || 1)) * span)
  return {
    domain,
    range,
    map,
    invert,
    clamp: (v: number) => Math.max(domain[0], Math.min(domain[1], v)),
  }
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const span = max - min
  const rawStep = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(Number(v.toFixed(10)))
  }
  return ticks
}

export function linePath(points: [number, number][]): string {
  if (points.length === 0) return ''
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
}

export function areaPath(points: [number, number][], baselineY: number): string {
  if (points.length === 0) return ''
  const top = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const last = points[points.length - 1]
  const first = points[0]
  return `${top} L${last[0].toFixed(2)},${baselineY.toFixed(2)} L${first[0].toFixed(2)},${baselineY.toFixed(2)} Z`
}

export function formatNumber(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 10000) return value.toExponential(2)
  if (abs < 0.001) return value.toExponential(1)
  return value.toFixed(digits)
}

export function formatSigned(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—'
  const s = formatNumber(Math.abs(value), digits)
  return value > 0 ? `+${s}` : value < 0 ? `−${s}` : '0'
}

export function formatLambda(value: number): string {
  if (value === 0) return '0'
  if (Math.abs(value) >= 0.01) return value.toFixed(value >= 1 ? 1 : 3)
  return value.toExponential(1).replace('e-', '×10⁻').replace('e+', '×10')
}

export function formatWavelength(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1)
}

export function niceExtent(values: number[], padding = 0.08): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return [0, 1]
  let min = Math.min(...finite)
  let max = Math.max(...finite)
  if (min === max) {
    const d = Math.abs(min) * 0.1 || 1
    min -= d
    max += d
  }
  const span = max - min
  return [min - span * padding, max + span * padding]
}
