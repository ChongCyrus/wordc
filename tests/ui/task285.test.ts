import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const memory = src('ui/study/components/MemoryStage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-285 w-c 顶部推荐流程', () => {
  it('非三小次顶部流程替换；三小次保持单行', () => {
    expect(memory).toContain('推荐学习流程')
    expect(memory).toContain('记忆词根缀含义')
    expect(memory).toContain('白板回忆的反馈')
    expect(memory).toContain('请熟悉/记忆下述映射')
    expect(memory).not.toContain('请进行下述次数')
    expect(css).toContain('.wc-root-process')
  })
})
