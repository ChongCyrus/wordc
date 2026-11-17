/** task-205：为可能挂起的读取加超时兜底（不取消底层 promise，只让 UI 可恢复） */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = '读取超时，请重试',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs))
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
