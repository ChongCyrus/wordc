/** task-192：批量生成超时/停止后的确定性收尾（避免一直「进行中 X/Y」） */
export const BATCH_STALL_TIMEOUT_MS = 30_000

export function isBatchStalled(
  lastProgressAt: number,
  now: number,
  timeoutMs = BATCH_STALL_TIMEOUT_MS,
): boolean {
  if (!Number.isFinite(lastProgressAt) || lastProgressAt <= 0) return false
  return now - lastProgressAt >= timeoutMs
}

export interface BatchRunSeed {
  wordId: string
  headword: string
}

export interface BatchFailureView {
  wordId: string
  headword: string
  message: string
}

export function summarizeStuckRun(input: {
  items: BatchRunSeed[]
  succeededIds: Iterable<string>
  skipped: number
  message?: string
}): {
  total: number
  succeeded: number
  failed: number
  skipped: number
  failures: BatchFailureView[]
} {
  const succeeded = new Set(input.succeededIds)
  const failures = input.items
    .filter((item) => !succeeded.has(item.wordId))
    .map((item) => ({
      wordId: item.wordId,
      headword: item.headword,
      message: input.message ?? 'AI 请求超时（未返回，可重试）',
    }))
  const skipped = Math.max(0, input.skipped)
  return {
    total: input.items.length,
    succeeded: succeeded.size,
    failed: failures.length,
    skipped,
    failures,
  }
}
