/** 0.15：同一词的 clicks/encounters 读改写串行，避免快速连点丢计数/旧结果回弹 */
const chains = new Map<string, Promise<unknown>>()

export function withStatsWriteLock<T>(wordId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(wordId) ?? Promise.resolve()
  const run = prev.then(task, task)
  const tracked = run.catch(() => undefined)
  chains.set(wordId, tracked)
  void tracked.finally(() => {
    if (chains.get(wordId) === tracked) chains.delete(wordId)
  })
  return run
}
