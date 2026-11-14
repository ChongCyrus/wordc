import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const studyCss = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

describe('学习页长文本/裁切修复（task-136 B1/B4/B5）', () => {
  it('助记完整换行不夹断（B1）', () => {
    const block = studyCss.slice(studyCss.indexOf('.meaning-mnemonic'), studyCss.indexOf('.meaning-mnemonic') + 220)
    expect(block).toContain('white-space: normal')
    expect(block).toContain('-webkit-line-clamp: unset')
    expect(studyCss).toContain('.mm-review-line')
  })

  it('本义链完整换行不裁切（B4）', () => {
    const block = studyCss.slice(studyCss.indexOf('.derivation-chain'), studyCss.indexOf('.derivation-chain') + 220)
    expect(block).toContain('white-space: normal')
    expect(block).toContain('overflow: visible')
  })

  it('本义区左右 ≥16px 防裁字（B5）', () => {
    const block = studyCss.slice(studyCss.indexOf('.core-senses'), studyCss.indexOf('.core-senses') + 220)
    expect(block).toContain('padding-left: 16px')
    expect(block).toContain('padding-right: 16px')
  })
})
