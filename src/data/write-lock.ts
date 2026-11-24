/** 0.10.0：同一 Dexie 库的破坏性写（reseed/import/restore）与评分串行，避免并发互相覆盖 */
let chain: Promise<unknown> = Promise.resolve()

export function withDataWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.catch(() => undefined)
  return run
}

/** 测试/诊断：当前是否还有排队写 */
export function pendingDataWrites(): Promise<void> {
  return chain.then(() => undefined, () => undefined)
}
