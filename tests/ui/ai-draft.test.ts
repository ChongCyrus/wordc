import { describe, expect, it } from 'vitest'
import {
  AI_BATCH_CONTINUE_STOP_LABEL,
  AI_BATCH_LIMIT_OPTIONS,
  batchSizeForLimit,
  draftResumeMessage,
  formatDraftProgress,
  isDraftComplete,
} from '../../src/app/hooks/aiDraft'

describe('AI 分片/断点续跑 UI 常量与函数（task-106）', () => {
  it('上限选项 50/100/500/全部 + 文案', () => {
    expect(AI_BATCH_LIMIT_OPTIONS.map((option) => option.value)).toEqual([50, 100, 500, 'all'])
    expect(AI_BATCH_CONTINUE_STOP_LABEL).toBe('生成一片先停')
  })

  it('batchSizeForLimit：按上限与剩余数取小；全部=剩余', () => {
    expect(batchSizeForLimit(50, 120)).toBe(50)
    expect(batchSizeForLimit(500, 120)).toBe(120)
    expect(batchSizeForLimit('all', 120)).toBe(120)
    expect(batchSizeForLimit(50, 0)).toBe(0)
  })

  it('进度/续跑文案', () => {
    expect(formatDraftProgress(120, 500)).toBe('已生成 120 / 总 500（草稿已保存）')
    expect(draftResumeMessage(120, 500)).toBe('继续上次生成（120/500）')
    expect(isDraftComplete(500, 500)).toBe(true)
    expect(isDraftComplete(120, 500)).toBe(false)
  })
})
