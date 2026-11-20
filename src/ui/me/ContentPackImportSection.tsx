/**
 * 「导入内容包」入口（task-71）：`.pack.json` 多文件。
 * 数据层 `importContentPack`（dev-data task-69）就绪后通过 onImportPack 注入；
 * 未注入时按钮禁用并提示接口未接通（避免误以为可导入）。
 */
import { useState } from 'react'
import { applyApproved, approveItems, importContentPack, listPackItems } from '../../data'
import { pickTextFiles } from '../../app/utils/files'
import { useToast } from '../../app/toast'

export interface ContentPackImportSectionProps {
  /** 测试注入；生产默认走 data.importContentPack → 审核 → applyApproved */
  onImportPack?: (files: File[]) => Promise<{ imported: number; failed: number }>
}

export function ContentPackImportSection({ onImportPack }: ContentPackImportSectionProps) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const handleClick = () => {
    void (async () => {
      setBusy(true)
      try {
        const files = await pickTextFiles('.pack.json,application/json', true)
        if (files.length === 0) return
        if (onImportPack) {
          const result = await onImportPack(files)
          toast.success(`内容包导入完成：成功 ${result.imported} 个，失败 ${result.failed} 个`)
          return
        }
        let applied = 0
        let failed = 0
        for (const file of files) {
          const imported = await importContentPack(file)
          if (!imported.ok || !imported.packId) {
            failed += 1
            continue
          }
          const records = await listPackItems(imported.packId)
          const ids = records.filter((record) => record.status === 'pending').map((record) => record.id)
          if (ids.length > 0) await approveItems(imported.packId, ids)
          const result = await applyApproved(imported.packId)
          applied += result.applied
          failed += result.skipped
        }
        toast.success(`内容包导入完成：应用 ${applied} 条，跳过 ${failed} 条`)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '内容包导入失败')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <div className="mm-list">
      <div className="mm-row">
        <span className="mm-row-main">
          <span className="mm-row-title">导入内容包</span>
          <span className="mm-row-sub">
            选择 `.pack.json` 文件（可多选）；内容包只写入本地词库用户包，不影响内置词库

          </span>
        </span>
        <button
          type="button"
          className="mm-btn"
          onClick={handleClick}
          disabled={busy}
        >
          {busy ? '导入中…' : '选择文件'}
        </button>
      </div>
    </div>
  )
}
