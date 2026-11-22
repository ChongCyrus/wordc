import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const memory = src('ui/study/components/MemoryStage.tsx')
const study = src('ui/study/StudyPage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-288 w-c 流程点击/三小次开关', () => {
  it('summary/details 不触发记忆计数；容器阻止冒泡', () => {
    expect(memory).toContain("target?.closest('details, summary, button, a, input, label, select, textarea')")
    expect(memory).toContain('className="memory-stage-tap"')
    expect(memory).toContain('轻触卡片，进入下一页')
    expect(memory).not.toContain('<details className="wc-root-process" open>')
    // 卡片 tap 容器在 wc-card 之前，info/phrases 等在其后（不在点击区）
    expect(memory.indexOf('memory-stage-tap')).toBeLessThan(memory.indexOf('className={`wc-card'))
    expect(memory.indexOf('className={`wc-card')).toBeLessThan(memory.indexOf('className="wc-info"'))
    // 提示必须在卡片之前，首屏可见
    expect(memory.indexOf('轻触卡片，进入下一页')).toBeLessThan(memory.indexOf('className={`wc-card'))
    expect(memory).not.toContain('role="button"\n      tabIndex={0}')
    expect(memory).toContain('className="wc-root-process"')
    // workflow 在 tap 容器之外：details 出现在 memory-stage-tap 之前
    expect(memory.indexOf('wc-root-process')).toBeLessThan(memory.indexOf('memory-stage-tap'))
  })

  it('三小次开关独立行不覆盖流程标题', () => {
    expect(study).toContain('memory-3tap-toggle')
    expect(study).not.toContain('className="weighted-core-only-toggle">\n          <input\n            type="checkbox"\n            checked={appSettings?.[\'memory.threeTapRecall\']')
    expect(css).toContain('.memory-3tap-toggle')
    const block = css.slice(css.indexOf('.memory-3tap-toggle'), css.indexOf('.memory-3tap-toggle') + 400)
    expect(block).not.toContain('position: fixed')
  })
})
