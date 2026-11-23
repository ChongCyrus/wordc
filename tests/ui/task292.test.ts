import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { shouldShowEtymologyExpand } from '../../src/ui/study/components/CollapsibleEtymologyLine'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const line = src('ui/study/components/CollapsibleEtymologyLine.tsx')
const memory = src('ui/study/components/MemoryStage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-292 w-c 词源折叠', () => {
  it('溢出判断/展开收起/短文本无按钮', () => {
    expect(shouldShowEtymologyExpand(40, 36)).toBe(true)
    expect(shouldShowEtymologyExpand(36, 36)).toBe(false)
    expect(line).toContain('scrollHeight')
    expect(line).toContain('clientHeight')
    expect(line).toContain("expanded ? '收起' : '展开'")
    expect(line).toContain('{overflow || expanded ?')
    expect(css).toContain('-webkit-line-clamp: 2')
    expect(css).toContain('.is-expanded .wc-root-etymology-line-clamp')
  })

  it('词源/组合接入折叠组件，parts 保持', () => {
    expect(memory).toContain('<CollapsibleEtymologyLine label="词源"')
    expect(memory).toContain('<CollapsibleEtymologyLine label="组合"')
    expect(memory).toContain('wc-root-etymology-part')
  })
})
