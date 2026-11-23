import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const generate = src('ui/decks/GeneratePage.tsx')
const jobs = src('ui/me/GenerationJobsPage.tsx')

describe('task-298 0.6.0 属性组筛选/统一任务 UI', () => {
  it('GeneratePage 复用 FilterTreeEditor，seed 求交并更新目标数', () => {
    expect(generate).toContain('FilterTreeEditor')
    expect(generate).toContain('queryAdvancedFilter({ wordIds, filter: propertyFilter')
    expect(generate).toContain('effectiveWordIds')
    expect(generate).toContain('属性筛选后')
    expect(generate).toContain('finalTargetCount')
    expect(generate).toContain('无可生成目标')
    expect(generate).toContain('GENERATE_TYPES.map((item) => [item.label, 0])')
    expect(generate).toContain('buildGenerationTargets({ kind: item.kind, wordIds: effectiveWordIds })')
  })

  it('任务中心暂停/取消/继续 + 类型/批次/并发', () => {
    expect(jobs).toContain('pauseGenerationJob')
    expect(jobs).toContain('cancelGenerationJob')
    expect(jobs).toContain('暂停')
    expect(jobs).toContain('取消')
    expect(jobs).toContain('类型 ${job.kinds.join')
    expect(jobs).toContain('批次 ${job.batchSize}')
    expect(jobs).toContain('并发 ${job.concurrency}')
  })
})
