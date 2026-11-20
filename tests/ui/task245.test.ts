import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)
const memory = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/MemoryStage.tsx', import.meta.url)),
  'utf8',
)

describe('task-245 hidden 竖直卡片式', () => {
  it('结构顺序 word→箭头→问号行；大问号 38px、词性同行右、卡片外观', () => {
    expect(memory.indexOf('wc-word')).toBeLessThan(memory.indexOf('wc-hidden-arrow'))
    expect(memory.indexOf('wc-hidden-arrow')).toBeLessThan(memory.indexOf('wc-hidden-question-row'))
    expect(memory.indexOf('wc-hidden-question-row')).toBeLessThan(memory.indexOf('wc-count-row'))
    expect(css).toContain('.wc-hidden-question')
    expect(css).toContain('font-size: 38px')
    expect(css).toContain('.wc-hidden-question-row')
    expect(css).toContain('align-items: baseline')
    expect(css).toContain('.wc-hidden-pos-item')
    // 记忆卡容器沿用 wc-card
    expect(memory).toContain('className="wc-card"')
  })
})
