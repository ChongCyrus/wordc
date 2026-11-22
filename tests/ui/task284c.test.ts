import { describe, expect, it } from 'vitest'
import { isRootEtymologyBundle } from '../../src/data'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-284 C1 词根缀源导出/导入', () => {
  it('入口/全部与当前词库导出/导入预览报告', () => {
    expect(me).toContain('导出词根缀源')
    expect(me).toContain('导入词根缀源')
    expect(me).toContain('exportRootEtymologyBundleText')
    expect(me).toContain('importRootEtymologyBundle')
    expect(me).toContain('JSON.parse(text)')
    expect(me).toContain('isRootEtymologyBundle(parsed)')
    expect(me).toContain('全部词库')
    expect(me).toContain('当前词库')
    expect(me).toContain('词根缀源导入报告')
    expect(me).toContain('跳过手改')
    expect(me).toContain('preserveManual: true')
  })

  it('string 需先 parse；合法对象通过、坏 JSON 拒绝', () => {
    expect(isRootEtymologyBundle('{"format":"momo-root-etymology-bundle"}')).toBe(false)
    expect(
      isRootEtymologyBundle({ format: 'momo-root-etymology-bundle', formatVersion: 1, items: [] }),
    ).toBe(true)
    expect(isRootEtymologyBundle({ format: 'x', formatVersion: 1, items: [] })).toBe(false)
  })
})
