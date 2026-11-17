/**
 * task-195 P0 回归：根元素卸载→重挂载后手势仍生效。
 *
 * 旧实现把监听绑在 containerRef.current（旧 `.study-page`）；StudyPage 在 loading/done 等
 * 阶段提前 return 会卸载根元素，恢复后挂载新元素，但 effect deps 不变 → 监听留在旧 DOM。
 * 新实现绑 document capture + 每次事件用 `.closest('.study-page')` 过滤，因此元素替换不影响。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { isStudyPageEventTarget } from '../../src/ui/study/lib/use-study-panel-gesture'

const hook = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/lib/use-study-panel-gesture.ts', import.meta.url)),
  'utf8',
)

function fakeTarget(closestResult: unknown, selector = '.study-page') {
  return {
    closest: (sel: string) => (sel === selector ? closestResult : null),
  }
}

describe('task-195 · 手势根元素重挂载回归', () => {
  it('document 级过滤：新挂载的 .study-page 目标可识别，旧/外部目标被忽略', () => {
    const page = {}
    expect(isStudyPageEventTarget(fakeTarget(page))).toBe(true)
    // 旧根元素已卸载：closest 不再命中 → 不会把事件算到旧页
    expect(isStudyPageEventTarget(fakeTarget(null))).toBe(false)
    // 非学习页（如首页/弹层）不响应：closest('.study-page') 返回 null
    expect(isStudyPageEventTarget({ closest: () => null })).toBe(false)
    expect(isStudyPageEventTarget(null)).toBe(false)
    expect(isStudyPageEventTarget(undefined)).toBe(false)
    expect(isStudyPageEventTarget({} as unknown)).toBe(false)
  })

  it('模拟卸载→重挂载：旧元素失效后，新元素目标仍能被过滤链识别', () => {
    // 旧根元素：卸载后 closest('.study-page') 返回 null
    const oldRoot = fakeTarget(null)
    // 新根元素：重新挂载后 closest('.study-page') 返回自身
    const newRoot = fakeTarget({ mounted: true })
    expect(isStudyPageEventTarget(oldRoot)).toBe(false)
    expect(isStudyPageEventTarget(newRoot)).toBe(true)
  })

  it('源码保证：监听绑 document capture，而不是 containerRef.current', () => {
    expect(hook).toContain('const doc = typeof document')
    expect(hook).toContain('doc.addEventListener')
    expect(hook).not.toContain('containerRef.current')
    expect(hook).toContain('}, [enabled])')
    expect(hook).toContain("closest('.study-page')")
    // 后台/失焦自愈：避免丢失 touchend 后 controller 永久 active
    expect(hook).toContain('visibilitychange')
    expect(hook).toContain("window.addEventListener('blur', onWindowBlur)")
    // 多指分支先 return，不会 reset 正在进行的单指手势；触屏 pointer 被忽略时也不 reset
    expect(hook).toContain('event.touches.length !== 1')
    expect(hook).toContain("if (event.pointerType === 'touch') return")
  })
})
