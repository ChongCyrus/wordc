import type { AutoBackupRestoreResult } from '../../data'

/** 恢复失败统一文案：优先 error，其次报告里的 error issue（避免只显示“恢复失败”丢原因） */
export function describeRestoreFailure(result: AutoBackupRestoreResult): string {
  if (result.error && result.error.trim()) return result.error
  const issue = result.report?.issues?.find((item) => item.level === 'error')
  if (issue) return issue.message
  return '恢复失败（备份格式/版本不兼容或合并校验未通过）'
}
