import { useCallback, useEffect, useRef, useState } from 'react'
import { forceImportDefaultGeneratedData, getGeneratedSeedStatus } from '../../data'
import type { GeneratedSeedStatus } from '../../data'

/** task-272：预装内容导入状态轮询 + 立即导入 */
export function useGeneratedSeedStatus(pollMs = 700) {
  const [status, setStatus] = useState<GeneratedSeedStatus | null>(null)
  const [importing, setImporting] = useState(false)
  const lastStateRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await getGeneratedSeedStatus()
      lastStateRef.current = next.state
      setStatus(next)
    } catch {
      // 状态读取失败不影响页面
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh()
    }
    const onSeedEvent = () => void refresh()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onVisible)
      window.addEventListener('momo:generated-seed-updated', onSeedEvent)
    }
    // 用 interval 而非递归 timeout：单次 getGeneratedSeedStatus 挂起时不会终止后续轮询
    const timer = window.setInterval(() => void refresh(), pollMs)
    return () => {
      window.clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onVisible)
        window.removeEventListener('momo:generated-seed-updated', onSeedEvent)
      }
    }
  }, [pollMs, refresh])

  const importNow = useCallback(async () => {
    setImporting(true)
    try {
      await forceImportDefaultGeneratedData()
    } finally {
      await refresh()
      setImporting(false)
    }
  }, [refresh])

  return { status, importing, refresh, importNow }
}
