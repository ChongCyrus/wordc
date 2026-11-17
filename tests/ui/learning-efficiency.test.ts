import { describe, expect, it } from 'vitest'
import { estimateActiveStudyMsFromLogs } from '../../src/app/hooks/useLearningEfficiency'

describe('task-137/F3：学习效率估算数据源', () => {
  it('相邻评分间隔计入活跃时间，单段最多 5 分钟；不足 2 条为 0', () => {
    expect(estimateActiveStudyMsFromLogs([])).toBe(0)
    expect(estimateActiveStudyMsFromLogs([1000])).toBe(0)
    expect(estimateActiveStudyMsFromLogs([0, 60_000, 120_000])).toBe(120_000)
    // 30 分钟挂机只计 5 分钟
    expect(estimateActiveStudyMsFromLogs([0, 30 * 60_000])).toBe(5 * 60_000)
  })
})
