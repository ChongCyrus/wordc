import { useEffect, useState } from 'react'

/** 监听 data 层 plan 写成功事件，触发首页/计划/统计重查 */
export function usePlanUpdatedRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1)
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') bump()
    }
    window.addEventListener('momo:plan-updated', bump)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('momo:plan-updated', bump)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return revision
}
