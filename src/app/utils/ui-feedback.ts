/** B 批次：计划/统计写入 fail-closed 的统一文案；SQLite 未移植入口提示 */
export const SQLITE_FEATURE_UNAVAILABLE_MESSAGE = '该功能暂时不可用，请更新/恢复'
export const WRITE_FAILED_MESSAGE = '操作未完成，请稍后重试'

export function isUnsupportedFeatureError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'E_UNSUPPORTED' || code === 'E_NOT_IMPLEMENTED') return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /未移植|not implemented|unsupported|暂时不可用|SQLite 不可用/i.test(message)
}

/** 失败提示只陈述真实错误，不返回成功文案 */
export function describeUiFailure(error: unknown, action = '操作'): string {
  if (isUnsupportedFeatureError(error)) return SQLITE_FEATURE_UNAVAILABLE_MESSAGE
  const detail = error instanceof Error && error.message ? error.message : typeof error === 'string' ? error : ''
  return detail ? `${action}失败：${detail}` : `${action}失败：${WRITE_FAILED_MESSAGE}`
}

/** 只有明确成功值才返回 true，避免“假成功” */
export function isExplicitSuccess(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true)
}
