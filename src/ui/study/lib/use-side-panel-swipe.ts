import { useCallback, useRef } from 'react'
import type {
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from 'react'

/** 纯函数：根据水平/纵向位移判断开/收（F8） */
export function sidePanelSwipeAction(input: {
  dx: number
  dy: number
  open: boolean
  threshold?: number
}): 'open' | 'close' | null {
  const threshold = input.threshold ?? 24
  const { dx, dy, open } = input
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return null
  if (dx < 0 && !open) return 'open'
  if (dx > 0 && open) return 'close'
  return null
}

import {
  DERIVATION_WIDTH_DEFAULT,
  clampDerivationPanelWidth,
} from './derivation-width'

/** task-175：按**相对位移**换算右页宽度（避免左半页滑动时突增到 70–80%） */
export function sidePanelWidthFromDrag(input: {
  startWidth: number
  dx: number
  viewportWidth: number
}): number {
  const vw = input.viewportWidth > 0 ? input.viewportWidth : 1
  return clampDerivationPanelWidth(input.startWidth - (input.dx / vw) * 100)
}

/** 注释面左滑打开右侧副页 / 右滑收起；打开后任意位置水平拖动可继续调宽（F8/A2/A7） */
export function useSidePanelSwipe(opts: {
  enabled: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** 拖动中实时给出右页宽度百分比（30–75） */
  onResize?: (widthPercent: number) => void
  /** 当前右页宽度（打开后拖拽的起点；缺省 50） */
  widthPercent?: number
  threshold?: number
}) {
  const {
    enabled,
    open,
    onOpen,
    onClose,
    onResize,
    widthPercent = DERIVATION_WIDTH_DEFAULT,
    threshold = 24,
  } = opts
  const startRef = useRef<{
    x: number
    y: number
    pointerId: number
    resizing?: boolean
    baseWidth?: number
    lastDx?: number
  } | null>(null)
  const viewportWidth = () => (typeof window === 'undefined' ? 0 : window.innerWidth)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      } catch {
        undefined
      }
      startRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        baseWidth: open ? widthPercent : DERIVATION_WIDTH_DEFAULT,
      }
    },
    [enabled],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = startRef.current
      if (!start || start.pointerId !== event.pointerId) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      start.lastDx = dx
      const horizontal = Math.abs(dx) > Math.abs(dy)
      if (!open && horizontal && dx < -threshold) {
        // task-181：打开当帧固定 50/50，并重置起点，之后才按相对位移继续拖
        onOpen()
        start.resizing = true
        start.baseWidth = DERIVATION_WIDTH_DEFAULT
        start.x = event.clientX
        start.y = event.clientY
        start.lastDx = 0
        return
      }
      if (!onResize) return
      const shouldResize = open || start.resizing
      if (!shouldResize || !horizontal) return
      if (Math.abs(dx) < 8 && !start.resizing) return
      onResize(
        sidePanelWidthFromDrag({
          startWidth: start.baseWidth ?? widthPercent,
          dx,
          viewportWidth: viewportWidth(),
        }),
      )
    },
    [onOpen, onResize, open, threshold, widthPercent],
  )

  const touchRef = useRef<{ x: number; y: number; baseWidth: number; resizing?: boolean } | null>(
    null,
  )

  const onTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      if (!enabled || event.touches.length !== 1) return
      const touch = event.touches[0]!
      touchRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        baseWidth: open ? widthPercent : DERIVATION_WIDTH_DEFAULT,
      }
    },
    [enabled, open, widthPercent],
  )

  const onTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      const start = touchRef.current
      const touch = event.touches[0]
      if (!start || !touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (!start.resizing) {
        if (Math.abs(dx) <= Math.abs(dy) || dx > -threshold) return
        // 水平左滑：打开并固定 50，重置起点
        onOpen()
        start.resizing = true
        start.baseWidth = DERIVATION_WIDTH_DEFAULT
        start.x = touch.clientX
        start.y = touch.clientY
        return
      }
      event.preventDefault?.()
      if (!onResize) return
      onResize(
        sidePanelWidthFromDrag({
          startWidth: start.baseWidth,
          dx: touch.clientX - start.x,
          viewportWidth: viewportWidth(),
        }),
      )
    },
    [onOpen, onResize, threshold],
  )

  const onTouchEnd = useCallback(() => {
    touchRef.current = null
  }, [])

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
    onPointerMove,
    onPointerUp: finish,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onPointerCancel: () => {
      // 浏览器取消（如纵向滚动接管）时只清空；已跨阈值打开由上方 pointerup 逻辑兜底
      startRef.current = null
    },
  }
}
