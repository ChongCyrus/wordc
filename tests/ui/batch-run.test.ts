import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import {
  BATCH_STALL_TIMEOUT_MS,
  isBatchStalled,
  summarizeStuckRun,
} from '../../src/ui/me/batch-run'

const panel = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/BatchDerivationPanel.tsx', import.meta.url)),
  'utf8',
)

describe('task-192 批量生成超时/重试收尾', () => {
  it('UI 30s watchdog（service 单条 30s 超时+自动重试）（task-194）', () => {
    expect(BATCH_STALL_TIMEOUT_MS).toBe(30_000)
    expect(isBatchStalled(0, 100_000)).toBe(false)
    expect(isBatchStalled(10_000, 39_999, 30_000)).toBe(false)
    expect(isBatchStalled(10_000, 40_000, 30_000)).toBe(true)
  })

  it('超时收尾：总数=成功+失败+跳过，未成功项列入可重试失败', () => {
    const items = Array.from({ length: 42 }, (_, index) => ({
      wordId: `w${index}`,
      headword: `word${index}`,
    }))
    const succeeded = items.slice(0, 40).map((item) => item.wordId)
    const result = summarizeStuckRun({ items, succeededIds: succeeded, skipped: 0 })
    expect(result.total).toBe(42)
    expect(result.succeeded).toBe(40)
    expect(result.failed).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.succeeded + result.failed + result.skipped).toBe(result.total)
    expect(result.failures.map((failure) => failure.headword).sort()).toEqual(['word40', 'word41'])
    expect(result.failures[0]!.message).toContain('超时')
  })

  it('重试/停止路径存在：watchdog、finishInterrupted、stopRun、重置进度', () => {
    expect(panel).toContain('executeBatch')
    expect(panel).toContain('finishInterrupted')
    expect(panel).toContain('stopRun')
    expect(panel).toContain('succeededIdsRef.current = new Set()')
    expect(panel).toContain("setSummary(null)")
    expect(panel).toContain("setRunning(false)")
    expect(panel).toContain('重试失败')
    expect(panel).toContain('自动重试')
    expect(panel).toContain('连续超时')
  })
})
