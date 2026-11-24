/**
 * Small dense linear-algebra helpers. Everything here works on plain number
 * arrays: the problems in this app are 5-15 variables wide and at most a few
 * thousand observations long, so clarity beats cleverness.
 */

export function dot(a: number[], b: number[], length = a.length): number {
  let s = 0
  for (let i = 0; i < length; i++) s += a[i] * b[i]
  return s
}

export function weightedDot(a: number[], b: number[], w: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i] * w[i]
  return s
}

export function zeros(n: number): number[] {
  return new Array<number>(n).fill(0)
}

export function zeros2(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => zeros(cols))
}

export function maxAbs(values: number[]): number {
  let m = 0
  for (const v of values) {
    const a = Math.abs(v)
    if (a > m) m = a
  }
  return m
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Gaussian elimination with partial pivoting. Returns null for singular systems. */
export function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = matrix.length
  if (n === 0) return []
  const a = matrix.map((row, i) => [...row, rhs[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (!Number.isFinite(a[pivot][col]) || Math.abs(a[pivot][col]) < 1e-14) return null
    if (pivot !== col) {
      const tmp = a[pivot]
      a[pivot] = a[col]
      a[col] = tmp
    }
    const d = a[col][col]
    for (let j = col; j <= n; j++) a[col][j] /= d
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const f = a[row][col]
      if (f === 0) continue
      for (let j = col; j <= n; j++) a[row][j] -= f * a[col][j]
    }
  }
  return a.map((row) => row[n])
}

export function invertMatrix(matrix: number[][]): number[][] | null {
  const n = matrix.length
  const out = zeros2(n, n)
  for (let c = 0; c < n; c++) {
    const rhs = zeros(n)
    rhs[c] = 1
    const sol = solveLinear(matrix, rhs)
    if (!sol) return null
    for (let r = 0; r < n; r++) out[r][c] = sol[r]
  }
  return out
}

export interface SymEigen {
  values: number[]
  vectors: number[][]
}

/**
 * Cyclic Jacobi eigensolver for a small symmetric matrix. Eigenvalues ascend;
 * vectors[k] is the eigenvector for values[k].
 */
export function symmetricEigen(matrix: number[][], maxSweeps = 80): SymEigen {
  const n = matrix.length
  const a = matrix.map((row) => [...row])
  const v = zeros2(n, n)
  for (let i = 0; i < n; i++) v[i][i] = 1

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j]
    }
    if (off < 1e-24) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q]
        if (Math.abs(apq) < 1e-18) continue
        const app = a[p][p]
        const aqq = a[q][q]
        const theta = (aqq - app) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j])
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => v.map((row) => row[i])),
  }
}

/** Condition number of the column space represented by its Gram matrix. */
export function conditionFromGram(gram: number[][]): number {
  const { values } = symmetricEigen(gram)
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const max = values[values.length - 1]
  const min = values[0]
  if (!(max > 1e-14)) return Number.POSITIVE_INFINITY
  if (min <= max * 1e-12) return Number.POSITIVE_INFINITY
  return Math.sqrt(max / Math.min(min, max))
}

export function effectiveRankFromGram(gram: number[][], tolerance = 1e-10): number {
  const { values } = symmetricEigen(gram)
  const max = Math.max(...values, 0)
  if (max <= 0) return 0
  return values.filter((v) => v > max * tolerance).length
}

/** Pearson correlation; returns 0 when either vector is constant. */
export function correlation(a: number[], b: number[], weights?: number[]): number {
  let ma = 0
  let mb = 0
  let sw = 0
  for (let i = 0; i < a.length; i++) {
    const w = weights ? weights[i] : 1
    ma += a[i] * w
    mb += b[i] * w
    sw += w
  }
  if (sw === 0) return 0
  ma /= sw
  mb /= sw
  let va = 0
  let vb = 0
  let cov = 0
  for (let i = 0; i < a.length; i++) {
    const w = weights ? weights[i] : 1
    const da = a[i] - ma
    const db = b[i] - mb
    va += w * da * da
    vb += w * db * db
    cov += w * da * db
  }
  if (va <= 1e-20 || vb <= 1e-20) return 0
  return cov / Math.sqrt(va * vb)
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const pos = clamp(q, 0, 1) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const f = pos - lo
  return sorted[lo] * (1 - f) + sorted[hi] * f
}
