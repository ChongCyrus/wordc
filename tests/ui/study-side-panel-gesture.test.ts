/**
 * task-185：学习页右页手势 = 拖分界线 1:1 跟手。
 * 视口 388px（dx→% 比例对照：-40≈10.3%，-160≈41%，-300→75 clamp）。
 * 用真实 touch/pointer 事件序列驱动纯控制器；DOM 接线由 study-swipe-source 源码测试锁定。
 */
import { describe, expect, it } from 'vitest'
import {
  StudyPanelGestureController,
  swipeOpenWidthFromDx,
  type PanelGestureEffect,
} from '../../src/ui/study/lib/panel-gesture'
import { clampSwipeSensitivity, readSwipeSensitivity } from '../../src/ui/study/lib/derivation-width'

const VW = 388

interface Harness {
  env: { isOpen: boolean; widthPercent: number; viewportWidth: number; sensitivity?: number }
  effects: PanelGestureEffect[]
  controller: StudyPanelGestureController
  apply: (effects: PanelGestureEffect[]) => void
  move: (x: number, y: number) => { preventDefault: boolean; effects: PanelGestureEffect[] }
}

function harness(init: { open?: boolean; width?: number; vw?: number; sensitivity?: number } = {}): Harness {
  const env = {
    isOpen: init.open ?? false,
    widthPercent: init.width ?? 50,
    viewportWidth: init.vw ?? VW,
    sensitivity: (init as { sensitivity?: number }).sensitivity ?? 1,
  }
  const effects: PanelGestureEffect[] = []
  const controller = new StudyPanelGestureController(() => env)
  const apply = (list: PanelGestureEffect[]): void => {
    for (const effect of list) {
      effects.push(effect)
      if (effect.type === 'open') {
        env.isOpen = true
        env.widthPercent = effect.widthPercent
      } else if (effect.type === 'close') env.isOpen = false
      else if (effect.type === 'resize') env.widthPercent = effect.widthPercent
    }
  }
  return {
    env,
    effects,
    controller,
    apply,
    move(x, y) {
      const result = controller.touchMove(x, y)
      apply(result.effects)
      return result
    },
  }
}

const widths = (h: Harness): number[] =>
  h.effects.filter((e) => e.type === 'resize').map((e) => (e as { widthPercent: number }).widthPercent)
const openEffects = (h: Harness) => h.effects.filter((e) => e.type === 'open') as Array<{ widthPercent: number }>

describe('task-187 · 灵敏度设置读取（derivation.swipeSensitivity）', () => {
  it('默认 1.0；clamp 0.2–3.0；越界/非法回退', () => {
    expect(readSwipeSensitivity(undefined)).toBe(1)
    expect(readSwipeSensitivity({ 'derivation.swipeSensitivity': 2.5 })).toBe(2.5)
    expect(readSwipeSensitivity({ 'derivation.swipeSensitivity': 0 })).toBe(0.2)
    expect(readSwipeSensitivity({ 'derivation.swipeSensitivity': 99 })).toBe(3)
    expect(clampSwipeSensitivity(Number.NaN)).toBe(1)
    expect(clampSwipeSensitivity(0.25)).toBe(0.3)
  })
})

describe('task-185 · 1:1 跟手：未打开时左滑直接按 rawWidth 打开', () => {
  it('dx=-40 ≈ 10.3%（不是 50），继续拖 -160 ≈ 41%、-300 → clamp 75', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    expect(h.move(194, 301).effects).toEqual([]) // 死区内
    h.move(160, 301) // dx=-40
    expect(openEffects(h)).toHaveLength(1)
    expect(openEffects(h)[0]!.widthPercent).toBeCloseTo(10.3, 1)
    h.move(40, 301) // dx=-160
    expect(widths(h).at(-1)).toBeCloseTo(41.2, 0)
    h.move(-100, 301) // dx=-300 → 77.3 → clamp 75
    expect(widths(h).at(-1)).toBe(75)
    h.apply(h.controller.touchEnd(-100))
    expect(h.env.isOpen).toBe(true)
    expect(h.env.widthPercent).toBeGreaterThanOrEqual(30)
  })

  it('死区 10px：不等待 24px；dx=-12 即打开（约 3.1%）', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    expect(h.move(194, 300).effects).toEqual([]) // -6px：死区内
    h.move(188, 300) // -12px：已过死区 → 立即打开，不等 24px
    expect(openEffects(h)).toHaveLength(1)
    expect(openEffects(h)[0]!.widthPercent).toBeCloseTo(3.1, 1)
  })

  it('task-190：短滑 -40 松手 raw>0 → 保持 10.3%（不吸附 30、不关闭）', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    h.move(160, 300)
    expect(openEffects(h)[0]!.widthPercent).toBeCloseTo(10.3, 1)
    h.apply(h.controller.touchEnd(160))
    expect(h.effects.some((e) => e.type === 'close')).toBe(false)
    expect(h.env.isOpen).toBe(true)
    expect(h.env.widthPercent).toBeCloseTo(10.3, 1)
  })

  it('滑到 -160 松手 ≥30 → 保持打开并最终 clamp 到 30–75', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    h.move(40, 300)
    h.apply(h.controller.touchEnd(40))
    expect(h.effects.some((e) => e.type === 'close')).toBe(false)
    expect(h.env.isOpen).toBe(true)
    expect(h.env.widthPercent).toBeGreaterThanOrEqual(30)
    expect(h.env.widthPercent).toBeLessThanOrEqual(75)
  })

  it('任意起点（x=20/200/380）比例一致', () => {
    for (const startX of [20, 200, 380]) {
      const h = harness()
      h.controller.touchStart(startX, 300)
      h.move(startX - 100, 300)
      expect(openEffects(h)[0]!.widthPercent).toBeCloseTo(swipeOpenWidthFromDx(-100, VW), 1)
      expect(openEffects(h)[0]!.widthPercent).toBeCloseTo(25.8, 0)
    }
  })
})

describe('task-185 · 已打开：继续 1:1 调宽/收窄，无跳变', () => {
  it('已开 50%：左拖 -50 ≈62.9%，右拖 +50 ≈37.1%', () => {
    const left = harness({ open: true, width: 50 })
    left.controller.touchStart(300, 300)
    left.move(250, 300)
    expect(widths(left).at(-1)).toBeCloseTo(62.9, 0)

    const right = harness({ open: true, width: 50 })
    right.controller.touchStart(100, 300)
    right.move(150, 300)
    expect(widths(right).at(-1)).toBeCloseTo(37.1, 0)
  })

  it('右页起手 x=300/330，dx=±50 → 62.8%/37.2%（与左半页同公式）', () => {
    for (const startX of [300, 330]) {
      for (const dx of [-50, 50]) {
        const h = harness({ open: true, width: 50 })
        h.controller.touchStart(startX, 300)
        h.move(startX + dx, 300)
        const expected = 50 - (dx / VW) * 100
        expect(widths(h).at(-1)).toBeCloseTo(expected, 0)
        h.apply(h.controller.touchEnd(startX + dx))
        expect(h.env.isOpen).toBe(true)
        expect(h.env.widthPercent).toBeGreaterThanOrEqual(30)
      }
    }
  })

  it('整屏任意起手 x=20/100/200/280/340（已开50）dx=±50 均 1:1 调宽', () => {
    for (const startX of [20, 100, 200, 280, 340]) {
      for (const dx of [-50, 50]) {
        const h = harness({ open: true, width: 50 })
        h.controller.touchStart(startX, 300)
        h.move(startX + dx, 300)
        expect(widths(h).at(-1)).toBeCloseTo(50 - (dx / VW) * 100, 0)
      }
    }
  })

  it('灵敏度 k=0.5/2.0：宽度 = startWidth - dx/vw*100*k', () => {
    const k05 = harness({ sensitivity: 0.5 })
    k05.controller.touchStart(200, 300)
    k05.move(120, 300) // dx=-80 → 80/388*100*0.5=10.3
    expect(openEffects(k05)[0]!.widthPercent).toBeCloseTo(10.3, 1)

    const k2 = harness({ sensitivity: 2 })
    k2.controller.touchStart(200, 300)
    k2.move(180, 300) // dx=-20 → 20/388*100*2=10.3
    expect(openEffects(k2)[0]!.widthPercent).toBeCloseTo(10.3, 1)

    const short2 = harness({ sensitivity: 2 })
    short2.controller.touchStart(200, 300)
    short2.move(160, 300) // task-190：dx=-40, k=2 → 40/388*100*2≈20.6，松手保持
    expect(openEffects(short2)[0]!.widthPercent).toBeCloseTo(20.6, 1)
    short2.apply(short2.controller.touchEnd(160))
    expect(short2.env.isOpen).toBe(true)
    expect(short2.env.widthPercent).toBeCloseTo(20.6, 1)

    const open05 = harness({ open: true, width: 50, sensitivity: 0.5 })
    open05.controller.touchStart(200, 300)
    open05.move(150, 300) // -50 → 50+6.4
    expect(widths(open05).at(-1)).toBeCloseTo(56.4, 0)

    const open2 = harness({ open: true, width: 50, sensitivity: 2 })
    open2.controller.touchStart(200, 300)
    open2.move(150, 300) // -50 → 50+25.8=75.8→75
    expect(widths(open2).at(-1)).toBe(75)
  })

  it('灵敏度 clamp：0/99 → 0.2/3.0', () => {
    const low = harness({ sensitivity: 0 })
    low.controller.touchStart(200, 300)
    low.move(100, 300) // dx=-100 → 100/388*100*0.2=5.15
    expect(openEffects(low)[0]!.widthPercent).toBeCloseTo(5.2, 1)
    const high = harness({ open: true, width: 50, sensitivity: 99 })
    high.controller.touchStart(200, 300)
    high.move(190, 300) // dx=-10 → 10/388*100*3=7.7 → 57.7
    expect(widths(high).at(-1)).toBeCloseTo(57.7, 0)
    expect(widths(high).at(-1)).toBeLessThanOrEqual(75)
  })

  it('拖动中允许 <30 跟手；松手 raw>0 → 保持当前宽度（不回弹/不吸附）', () => {
    const h = harness({ open: true, width: 50 })
    h.controller.touchStart(100, 300)
    h.move(250, 300) // 右拖 150 → 50-38.7=11.3 >0
    expect(h.env.widthPercent).toBeCloseTo(11.3, 0)
    expect(h.env.isOpen).toBe(true)
    h.apply(h.controller.touchEnd(250))
    expect(h.env.isOpen).toBe(true)
    expect(h.env.widthPercent).toBeCloseTo(11.3, 0)
  })

  it('打开后右拖回收窄到 0 也跟手；松手关闭', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    h.move(160, 300) // 打开 10.3
    h.move(210, 300) // 回拖到 raw<0 → live 0
    expect(h.env.widthPercent).toBe(0)
    h.apply(h.controller.touchEnd(210))
    expect(h.effects.some((e) => e.type === 'close')).toBe(true)
  })

  it('左拖超过 75 → 始终 clamp 75', () => {
    const h = harness({ open: true, width: 50 })
    h.controller.touchStart(300, 300)
    h.move(0, 300) // -300 → 50+77.3→75
    expect(h.env.widthPercent).toBe(75)
    h.move(-100, 300) // 继续左拖仍 75
    expect(h.env.widthPercent).toBe(75)
  })
})

describe('task-185 · 手势来源/取消/纵向', () => {
  it('纵向滚动不打开、不 preventDefault', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    const r1 = h.move(202, 340)
    const r2 = h.move(205, 420)
    expect(r1.preventDefault).toBe(false)
    expect(r2.preventDefault).toBe(false)
    expect(h.effects).toEqual([])
  })

  it('pointercancel 后 touch fallback 仍可 1:1 打开', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    h.controller.pointerDown(200, 300, 'touch')
    h.controller.pointerMove(190, 300, 'touch')
    h.apply(h.controller.pointerCancel('touch'))
    expect(h.effects).toEqual([])
    const r = h.move(160, 300)
    expect(r.preventDefault).toBe(true)
    expect(openEffects(h)[0]!.widthPercent).toBeCloseTo(10.3, 1)
  })

  it('pointer 与 touch 同时到达：只打开一次，无不必要 resize', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    h.controller.pointerDown(200, 300, 'touch')
    h.move(160, 300)
    h.controller.pointerMove(160, 300, 'touch')
    expect(openEffects(h)).toHaveLength(1)
    expect(widths(h)).toHaveLength(0)
  })

  it('关闭态右滑无动作（task-188 取消右滑回退上一词）', () => {
    const h = harness()
    h.controller.touchStart(100, 300)
    h.move(180, 300) // dx=+80
    expect(h.effects).toEqual([])
    expect(h.env.isOpen).toBe(false)
    h.apply(h.controller.touchEnd(180))
    expect(h.effects).toEqual([])
  })

  it('无位移点击/未过死区不打开，不误触', () => {
    const h = harness()
    h.controller.touchStart(200, 300)
    h.apply(h.controller.touchEnd(200))
    expect(h.effects).toEqual([])
    expect(h.env.isOpen).toBe(false)
  })

  it('鼠标 pointer 路径同样 1:1（-160 ≈41%）', () => {
    const h = harness()
    h.controller.pointerDown(200, 300, 'mouse')
    h.apply(h.controller.pointerMove(40, 300, 'mouse').effects)
    expect(openEffects(h)[0]!.widthPercent).toBeCloseTo(41.2, 0)
    h.apply(h.controller.pointerUp(40, 'mouse'))
    expect(h.env.isOpen).toBe(true)
  })
})
