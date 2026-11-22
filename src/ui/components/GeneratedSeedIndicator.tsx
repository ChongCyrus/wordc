import { useEffect, useRef } from 'react'
import { useToast } from '../../app/toast'
import { useGeneratedSeedStatus } from '../../app/hooks/useGeneratedSeedStatus'

/** task-272：全局轻量预装内容导入提示（不阻塞操作） */
export function GeneratedSeedIndicator() {
  const toast = useToast()
  const { status } = useGeneratedSeedStatus(800)
  const prevStateRef = useRef<string | null>(null)

  useEffect(() => {
    if (!status) return
    const prev = prevStateRef.current
    if (prev === 'running' && status.state === 'completed') {
      toast.success(
        `预装内容导入完成：本义助记 ${status.senseImported ?? 0} 条 / 引申图 ${status.derivationImported ?? 0} 词`,
      )
    }
    if (prev === 'running' && status.state === 'failed') {
      toast.error(`预装内容导入失败，下次启动重试${status.error ? `（${status.error}）` : ''}`)
    }
    prevStateRef.current = status.state
  }, [status, toast])

  if (!status?.supported || status.state !== 'running') return null
  const total = Math.max(1, status.total || 0)
  const done = Math.min(total, status.done || 0)
  return (
    <div className="generated-seed-indicator" role="status" aria-live="polite">
      <span>预装内容导入中 {done}/{status.total || 0}</span>
      <span className="generated-seed-bar">
        <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </span>
    </div>
  )
}
