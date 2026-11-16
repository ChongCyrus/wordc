import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../../src/ui/ai/AiGeneratePanel.tsx', import.meta.url)),
  'utf8',
)

describe('task-201 草稿放弃后无法重新生成', () => {
  it('完成草稿/待继续守卫早退会释放 startLock', () => {
    expect(source).toContain("setSummary('草稿已生成完成：请先审核/应用或放弃草稿，再开始新的生成')")
    expect(source).toContain("setSummary('存在未完成的生成草稿：请先点「继续」或「放弃草稿」，再开始新的生成')")
    expect((source.match(/startLockRef\.current = false/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('放弃草稿清空 draft/pending/items/summary/error/progress 并释放锁', () => {
    const block = source.slice(source.indexOf('放弃草稿？'), source.indexOf('放弃草稿？') + 2000)
    expect(block).toContain('setDraftId(null)')
    expect(block).toContain('setPending([])')
    expect(block).toContain('setItems([])')
    expect(block).toContain('setSummary(null)')
    expect(block).toContain('setError(null)')
    expect(block).toContain('startLockRef.current = false')
  })
})
