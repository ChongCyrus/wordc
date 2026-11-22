import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { SWIPE_BACK_THRESHOLD, shouldTriggerSwipeBack, swipeDragOffset } from './swipe-back'

export interface SwipeBackOptions {
  /** plan 驱动的回退可用时才启用（首词/无 plan 时禁用，不拦截任何手势） */
  enabled: boolean
  onBack: () => void
  threshold?: number
}

export interface SwipeBackResult {
  /** 挂到单词卡/内容容器上的 pointer 事件 */
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  }
  /** 拖动中的水平位移（用于 translateX 反馈；0 表示静止） */
  offset: number
  dragging: boolean
}

/**
 * 单词卡水平右滑回退手势（task-30 框架，data 就绪后由页面传入 onBack 接线）。
 * - 只响应 pointer 拖动，不阻止默认滚动；点击（无位移）不会触发回退。
 * - 纵向滚动优先：|dx| <= |dy| 时不产生位移。
 */
export function useSwipeBack({ enabled, onBack, threshold = SWIPE_BACK_THRESHOLD }: SwipeBackOptions): SwipeBackResult {
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const [offset, setOffset] = useState(0)

  const reset = useCallback(() => {
    startRef.current = null
    setOffset(0)
  }, [])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      startRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    },
    [enabled],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = startRef.current
      if (!start || start.pointerId !== event.pointerId) return
      setOffset(swipeDragOffset(start, { x: event.clientX, y: event.clientY }))
    },
    [],
  )

  const finish = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = startRef.current
      if (!start || start.pointerId !== event.pointerId) {
        reset()
        return
      }
      const end = { x: event.clientX, y: event.clientY }
      const triggered = shouldTriggerSwipeBack(start, end, threshold)
      reset()
      if (triggered) onBack()
    },
    [onBack, reset, threshold],
  )

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: reset,
    },
    offset,
    dragging: offset > 0,
  }
}
