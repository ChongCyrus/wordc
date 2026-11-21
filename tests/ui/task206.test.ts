import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

describe('task-206 390 分栏左栏不竖排', () => {
  it('本义卡头部 flex-wrap，label 有整行宽度；徽标不参与压缩', () => {
    const head = css.slice(css.indexOf('/* task-206'), css.indexOf('/* task-206') + 1600)
    expect(head).toContain('.core-sense-head { flex-wrap: wrap;')
    expect(head).toContain('.core-sense-label { flex: 1 1 120px; min-width: 0;')
    expect(head).toContain('.core-sense-badge { align-self: flex-start; }')
  })

  it('AI 按钮整按钮换行、按钮内 nowrap；窄栏留更多文字宽度', () => {
    const block = css.slice(css.indexOf('/* task-206'))
    expect(block).toContain('.annotation-ai-rare { flex-wrap: wrap;')
    expect(block).toContain('white-space: nowrap')
    expect(block).toContain('word-break: keep-all')
    expect(block).toContain('@media (max-width: 520px)')
    expect(block).toContain('.core-senses { padding-left: 12px; padding-right: 12px; }')
    expect(block).toContain('.core-sense-label { font-size: 14px; line-height: 20px; }')
  })
})
