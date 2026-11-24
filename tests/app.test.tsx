// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { App } from '../src/App'
import { WorkbenchProvider } from '../src/state'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(WorkbenchProvider, null, createElement(App)))
  })
  return container
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

async function flush() {
  await act(async () => {})
}

function changeSelect(el: HTMLElement, selector: string, value: string) {
  const select = el.querySelector(selector) as HTMLSelectElement
  expect(select, selector).toBeTruthy()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/**
 * The chart resolves pointer x through `getBoundingClientRect`, which is all
 * zeroes in happy-dom. Stubbing it to a known box lets the brush be driven the
 * same way a mouse would drive it — the actual pointer handlers run.
 */
function stubChartGeometry(svg: SVGSVGElement, width = 720) {
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height: 320, right: width, bottom: 320, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  const capture = new Set<number>()
  svg.setPointerCapture = (id: number) => void capture.add(id)
  svg.releasePointerCapture = (id: number) => void capture.delete(id)
  svg.hasPointerCapture = (id: number) => capture.has(id)
}

async function brush(svg: SVGSVGElement, fromPx: number, toPx: number) {
  const fire = (type: string, clientX: number) => {
    const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent
    Object.defineProperty(ev, 'clientX', { value: clientX })
    Object.defineProperty(ev, 'pointerId', { value: 1 })
    act(() => {
      svg.dispatchEvent(ev)
    })
  }
  fire('pointerdown', fromPx)
  fire('pointermove', (fromPx + toPx) / 2)
  fire('pointermove', toPx)
  fire('pointerup', toPx)
  await flush()
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  localStorage.clear()
})

describe('workbench page', () => {
  it('renders the three-column workbench and auto-solves on load', async () => {
    const el = render()
    await settle()
    expect(el.querySelectorAll('.card').length).toBeGreaterThan(5)
    expect(el.querySelector('.rail-left')).toBeTruthy()
    expect(el.querySelector('.rail-center')).toBeTruthy()
    expect(el.querySelector('.rail-right')).toBeTruthy()
    expect(el.textContent).toContain('可辨识性')
    expect(el.textContent).toContain('解算结果')
    expect(el.textContent).toContain('执行解算')
    // First paint must already carry a result, not an empty state.
    expect(el.querySelector('.conc-number')).toBeTruthy()
    expect(el.querySelectorAll('svg.chart').length).toBeGreaterThan(0)
  })

  it('reports only the merged total on the collinear library, then separates on the re-measured one', async () => {
    const el = render()
    await settle()
    // The built-in default is the legacy library, where A and B are collinear.
    expect(el.querySelector('.rail-right')!.textContent).toContain('只能合计')
    expect(el.textContent).toContain('组分 A + 组分 B（合计）')

    changeSelect(el, 'select[aria-label="参考库"]', 'lib-v2')
    await settle()
    // Identifiability is decided afresh for the new reference set.
    expect(el.querySelector('.rail-right')!.textContent).toContain('所有组分都可单独辨识')
    // …and the old paired result is not silently presented as current.
    expect(el.textContent).toContain('当前显示的是旧解算结果')
    expect(el.textContent).toContain('参考库已从「标定库 2025.1」更换为当前库')

    act(() => {
      ;(el.querySelector('.banner .btn-primary') as HTMLButtonElement).click()
    })
    await settle()
    expect(el.textContent).not.toContain('当前显示的是旧解算结果')
    // The old result is kept with the library that produced it.
    const history = el.querySelector('.rail-right')!.textContent ?? ''
    expect(history).toContain('换库归档')
    expect(history).toContain('标定库 2025.1')
  })

  it('brush-selects a peak, masks it, and drops the affected interval after re-solving', async () => {
    const el = render()
    await settle()
    changeSelect(el, 'select[aria-label="参考库"]', 'lib-v2')
    await settle()
    act(() => {
      ;(el.querySelector('.banner .btn-primary') as HTMLButtonElement).click()
    })
    await settle()
    expect(el.querySelector('.rail-right')!.textContent).toContain('已辨识')

    const svg = el.querySelector('svg.chart.is-brushable') as SVGSVGElement
    expect(svg).toBeTruthy()
    stubChartGeometry(svg)
    // The plot starts after a 56 px y-axis gutter and spans 412–748 nm over
    // 646 px, so 505 and 532 nm sit near x = 235 and 287.
    await brush(svg, 235, 287)

    const left = el.querySelector('.rail-left')!.textContent ?? ''
    const chip = el.querySelector('.mask-item .range-display')!.textContent ?? ''
    const [lo, hi] = chip.match(/\d+/g)!.map(Number)
    expect(left).toContain('屏蔽')
    // The brushed window must cover A's 518 nm main band and be tight enough
    // to leave C's 604 nm band alone.
    expect(lo).toBeLessThanOrEqual(510)
    expect(hi).toBeGreaterThanOrEqual(525)
    expect(hi).toBeLessThan(570)

    act(() => {
      ;(el.querySelector('.rail-left .btn-primary') as HTMLButtonElement).click()
    })
    await settle()

    const results = el.querySelector('.rail-right')!.textContent ?? ''
    expect(results).toContain('区间作废')
    expect(results).toContain('峰区被屏蔽，区间作废')
    expect(results).toContain('旧不确定范围作废')
    // Only the masked component loses its interval; the others keep theirs.
    expect(results).toContain('± 0.')
    // Removing the mask restores the interval on the next solve.
    act(() => {
      ;(el.querySelector('.mask-item .btn-danger') as HTMLButtonElement).click()
    })
    await settle()
    expect(el.querySelector('.rail-left')!.textContent).not.toContain('屏蔽 50')
  })

  it('labels broad unmodelled structure as unexplained, not as dozens of bad points', async () => {
    const el = render()
    await settle()
    const text = el.querySelector('.rail-center')!.textContent ?? ''
    // UN-01 carries an unmodelled narrow-line contaminant at 505 / 736 nm plus
    // two genuine spikes at 574 and 713 nm. The bands are model error; only the
    // spikes are bad points, so the count must stay small.
    const match = text.match(/局部坏点（(\d+)）/)
    expect(match).toBeTruthy()
    expect(Number(match![1])).toBeLessThanOrEqual(4)
    expect(text).toContain('574 nm')
    expect(text).toContain('713 nm')
    expect(text).toContain('不能解释的信号')
    expect(text).toContain('未建模污染 P')
  })
})
