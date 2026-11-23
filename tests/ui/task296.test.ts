import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const filter = readFileSync(
  fileURLToPath(new URL('../../src/ui/decks/AdvancedFilterPage.tsx', import.meta.url)),
  'utf8',
)

describe('task-296 选择前N/划分批次/临时复习 ReviewChoiceDialog', () => {
  it('前 N、每批 N、chips、批次标签', () => {
    expect(filter).toContain('选择前 N 个')
    expect(filter).toContain('每批词数')
    expect(filter).toContain('chunkWordIds(selected, batchSize)')
    expect(filter).toContain('第 {index + 1} 批 · {batch.length} 词')
    expect(filter).toContain('第${activeBatchIndex + 1}批 ${actionIds.length}词')
    expect(filter).toContain('activeBatchIndex')
  })

  it('保存/载入批次 + 卡片 M 批', () => {
    expect(filter).toContain('batchSize,')
    expect(filter).toContain('batches,')
    expect(filter).toContain('setBatches(Array.isArray(set.batches)')
    expect(filter).toContain('${set.batches.length} 批')
  })

  it('临时复习恢复 ReviewChoiceDialog（计划/立即+recordMode/requeue）', () => {
    expect(filter).toContain('<ReviewChoiceDialog')
    expect(filter).toContain('appendWordsToTodayPlan')
    expect(filter).toContain("onStartTemp={(mode, autoRequeue) =>")
    expect(filter).toContain('recordMode=${mode}')
    expect(filter).toContain('autoRequeue=1')
    expect(filter).toContain('/filter?restore=1')
  })
})
