import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const hook = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/hooks/useStudySession.ts', import.meta.url)),
  'utf8',
)

describe('task-275 最后词 requeue 完成判断', () => {
  it('评分后回读最新 plan 再判断完成；保留调试日志', () => {
    expect(hook).toContain('const fresh = await getTodayPlan')
    expect(hook).toContain('if (fresh) planAfter = fresh')
    expect(hook).toContain("console.debug('[rate]'")
    expect(hook).toContain('planAfter.index >= planAfter.wordIds.length')
    expect(hook).not.toContain('planAfter.completedAt != null ||')
    expect(hook).toContain("localStorage.setItem(diagKey")
    expect(hook).toContain('momo:rate-diag')
  })
})
