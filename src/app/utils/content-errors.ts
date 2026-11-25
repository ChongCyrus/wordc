/** 0.14：内容备份/存储结构化错误统一 UX；E_DOWNGRADE 不允许读成“空库” */
export const CONTENT_DOWNGRADE_MESSAGE =
  '版本不支持该内容备份：请使用新版 App 或回退包，不要清空数据库'

export function isContentDowngradeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'E_DOWNGRADE') return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /E_DOWNGRADE|schema.*高于|版本不支持.*内容|downgrade/i.test(message)
}

export function mapContentError(error: unknown, fallback = '内容备份操作失败'): string {
  if (isContentDowngradeError(error)) return CONTENT_DOWNGRADE_MESSAGE
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message || fallback
}
