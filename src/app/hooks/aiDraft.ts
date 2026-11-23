/** AI 分片生成/断点续跑 UI 常量与纯函数（task-106；等 dev-data draft API 接线）。 */
export type AiBatchLimit = 50 | 100 | 500 | 'all'

export const AI_BATCH_LIMIT_OPTIONS: ReadonlyArray<{ value: AiBatchLimit; label: string }> = [
  { value: 50, label: '50' },
  { value: 100, label: '100' },
  { value: 500, label: '500' },
  { value: 'all', label: '全部' },
]

export const AI_BATCH_CONTINUE_STOP_LABEL = '生成一片先停'
export const AI_BATCH_CONTINUE_LABEL = '继续生成'
export const AI_DISCARD_DRAFT_LABEL = '放弃草稿'
export const AI_DISCARD_DRAFT_CONFIRM = '放弃后未生成的内容草稿会删除，已应用内容不受影响。'

/** 本次实际最多生成多少目标（根据上限与剩余总数） */
export function batchSizeForLimit(limit: AiBatchLimit, remaining: number): number {
  const safeRemaining = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0
  if (limit === 'all') return safeRemaining
  return Math.min(Math.max(1, Math.floor(limit)), safeRemaining)
}

/** 「已生成 X / 总 Y（草稿已保存）」 */
export function formatDraftProgress(done: number, total: number, draftSaved = true): string {
  const safeDone = Number.isFinite(done) ? Math.max(0, Math.round(done)) : 0
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0
  return `已生成 ${safeDone} / 总 ${safeTotal}（${draftSaved ? '草稿已保存' : '草稿未保存'}）`
}

/** 重开面板时草稿提示「继续上次生成（X/Y）」 */
export function draftResumeMessage(done: number, total: number): string {
  const safeDone = Number.isFinite(done) ? Math.max(0, Math.round(done)) : 0
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0
  return `继续上次生成（${safeDone}/${safeTotal}）`
}

export function isDraftComplete(done: number, total: number): boolean {
  return total > 0 && done >= total
}
