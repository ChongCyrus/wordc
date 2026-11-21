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
    let timer: number | null = null
    const tick = () => {
      void refresh()
      timer = window.setTimeout(tick, pollMs)
    }
    timer = window.setTimeout(tick, pollMs)
    return () => {
      if (timer != null) window.clearTimeout(timer)
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
