import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/** 纯函数：根据水平/纵向位移判断开/收（F8） */
export function sidePanelSwipeAction(input: {
  dx: number
  dy: number
  open: boolean
  threshold?: number
}): 'open' | 'close' | null {
  const threshold = input.threshold ?? 56
  const { dx, dy, open } = input
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return null
  if (dx < 0 && !open) return 'open'
  if (dx > 0 && open) return 'close'
  return null
}

/** 注释面左滑打开右侧副页 / 右滑收起（F8；与 swipe-back 独立，动作方向相反） */
export function useSidePanelSwipe(opts: {
  enabled: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  threshold?: number
}) {
  const { enabled, open, onOpen, onClose, threshold = 56 } = opts
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      startRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    },
    [enabled],
  )

  const finish = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = startRef.current
      startRef.current = null
      if (!start || start.pointerId !== event.pointerId) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      const action = sidePanelSwipeAction({ dx, dy, open, threshold })
      if (action === 'open') onOpen()
      else if (action === 'close') onClose()
    },
    [onClose, onOpen, open, threshold],
  )

  return {
    onPointerDown,
    onPointerUp: finish,
    onPointerCancel: () => {
      startRef.current = null
    },
  }
}
