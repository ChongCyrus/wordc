/**
 * 学习页右页手势的 DOM 接线（task-184）。
 *
 * 用**原生事件监听**而不是 React 合成事件：
 * - `touchmove` 以 `{ passive: false }` 绑定，横向手势锁定后 `preventDefault()` 才真正生效
 *   （React 17+ 在 root 上把 touchstart/touchmove/wheel 注册为 passive，合成事件里 preventDefault 无效）；
 * - 触屏只走 touch；pointer 事件里 `pointerType === 'touch'` 一律忽略，避免 pointer+touch 双路径重复
 *   onOpen/resize 造成宽度突增；
 * - 鼠标/笔仍走 pointer（桌面/调试可拖）。
 *
 * 手势判定/两阶段逻辑全部在 `StudyPanelGestureController`（纯逻辑、单测覆盖）。
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import {
  StudyPanelGestureController,
  type PanelGestureConfig,
  type PanelGestureEffect,
} from './panel-gesture'
import { clampLiveDerivationWidth } from './derivation-width'

/**
 * task-195：手势是否落在学习页内（document 级监听时用于过滤其它页面）。
 * 用结构化判断，便于 node 单测（不依赖 jsdom）。
 */
export function isStudyPageEventTarget(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null | undefined
  if (!el || typeof el.closest !== 'function') return false
  return Boolean(el.closest('.study-page'))
}

export interface StudyPanelGestureOptions {
  enabled: boolean
  /** @deprecated task-195：监听已改绑 document；保留字段仅为调用方兼容/测试 */
  containerRef?: RefObject<HTMLElement | null>
  isOpen: boolean
  widthPercent: number
  /** task-187：滑动灵敏度（0.2–3.0，默认 1.0） */
  sensitivity?: number
  onOpen: (widthPercent: number) => void
  onClose: () => void
  onResize: (widthPercent: number) => void
  config?: PanelGestureConfig
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth
}

export function useStudyPanelGesture(opts: StudyPanelGestureOptions): void {
  const envRef = useRef({
    isOpen: opts.isOpen,
    widthPercent: opts.widthPercent,
    viewportWidth: viewportWidth(),
    sensitivity: opts.sensitivity ?? 1,
  })
  envRef.current = {
    isOpen: opts.isOpen,
    widthPercent: opts.widthPercent,
    viewportWidth: viewportWidth(),
    sensitivity: opts.sensitivity ?? 1,
  }

  const cbRef = useRef({ onOpen: opts.onOpen, onClose: opts.onClose, onResize: opts.onResize })
  cbRef.current = { onOpen: opts.onOpen, onClose: opts.onClose, onResize: opts.onResize }

  const configRef = useRef(opts.config)
  configRef.current = opts.config

  const { enabled } = opts

  useEffect(() => {
    // P0 修复（task-195）：监听绑 document capture，而不是 containerRef 指向的旧 DOM。
    // 已证实风险窗口：StudyPage 在 phase='loading'|'error' 时提前 return 一个**不挂 pageRef** 的
    // `.study-page`；而 useStudySession.load() 开头 setPhase('loading') **不清理 session**，
    // 因此若在已有 session 时进入 loading/error，stage 仍 annotation、enabled 仍 true，
    // pageRef.current 却已变化；旧 effect deps [enabled,containerRef] 不变 → 监听留在旧 DOM，
    // 导致「用久后手势彻底失效」。done/empty 路径会 applySession(null)→enabled=false，会重绑，
    // 不是主要风险窗口。
    // 事件处理内用 `.closest('.study-page')` 限定范围，避免影响其它页面。
    const doc = typeof document === 'undefined' ? null : document
    if (!doc || !enabled) return

    const controller = new StudyPanelGestureController(() => envRef.current, configRef.current)
    // 横向手势消费后抑制随后的 click（避免从「‹ 引申」按钮起手滑动时又触发按钮 onClick）
    let claimed = false
    let suppressClickUntil = 0
    // 只抑制「手势起点所在的可交互元素」的后续 click（避免误伤顶部回退/其它按钮）
    let gestureStartInteractive: Element | null = null
    const INTERACTIVE_SELECTOR =
      'button,a,[role="button"],input,textarea,select,label,.meaning-row'
    const apply = (effects: PanelGestureEffect[]): void => {
      for (const effect of effects) {
        if (effect.type === 'open') cbRef.current.onOpen(effect.widthPercent)
        else if (effect.type === 'close') cbRef.current.onClose()
        else if (effect.type === 'resize') cbRef.current.onResize(clampLiveDerivationWidth(effect.widthPercent))
      }
    }

    /** task-202：任何 modal（AI 面板/确认框/批量面板/生成式等）打开时禁用右页手势 */
    const hasBlockingModal = (): boolean => {
      if (typeof document === 'undefined') return false
      return Boolean(
        document.querySelector('.mm-mask, .mm-dialog, [role="dialog"], .batch-derivation'),
      )
    }

    const onTouchStart = (event: TouchEvent): void => {
      if (hasBlockingModal()) return
      if (!isStudyPageEventTarget(event.target)) return
      claimed = false
      gestureStartInteractive =
        event.target instanceof Element ? event.target.closest(INTERACTIVE_SELECTOR) : null
      if (event.touches.length !== 1) {
        controller.touchCancel()
        return
      }
      // 自愈：若上一次手势因 target 被卸载等原因漏了 touchend，新单指触摸说明旧手势已结束
      controller.reset()
      const touch = event.touches[0]
      if (touch) controller.touchStart(touch.clientX, touch.clientY)
    }
    const onTouchMove = (event: TouchEvent): void => {
      if (hasBlockingModal()) return
      if (event.touches.length !== 1) {
        controller.touchCancel()
        return
      }
      const touch = event.touches[0]
      if (!touch) {
        controller.touchCancel()
        return
      }
      const result = controller.touchMove(touch.clientX, touch.clientY)
      if (result.preventDefault) claimed = true
      // 关键：只有横向手势才阻止默认滚动（纵向滚动/按钮点击不受影响）
      if (result.preventDefault && event.cancelable) event.preventDefault()
      apply(result.effects)
    }
    const onTouchEnd = (event: TouchEvent): void => {
      const touch = event.changedTouches?.[0]
      apply(controller.touchEnd(touch?.clientX))
      // 取消 touchend 阻止兼容 click（部分 WebView 即便 touchmove 不可取消也会补 click）
      if (claimed && event.cancelable) event.preventDefault()
      if (claimed) suppressClickUntil = Date.now() + 300
      claimed = false
    }
    const onTouchCancel = (): void => {
      apply(controller.touchCancel())
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (hasBlockingModal()) return
      if (!isStudyPageEventTarget(event.target)) return
      claimed = false
      gestureStartInteractive =
        event.target instanceof Element ? event.target.closest(INTERACTIVE_SELECTOR) : null
      if (event.pointerType === 'touch') return
      controller.reset()
      controller.pointerDown(event.clientX, event.clientY, event.pointerType, event.button)
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      const result = controller.pointerMove(event.clientX, event.clientY, event.pointerType)
      if (result.preventDefault) claimed = true
      if (result.preventDefault && event.cancelable) event.preventDefault()
      apply(result.effects)
    }
    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      apply(controller.pointerUp(event.clientX, event.pointerType))
      if (claimed) {
        suppressClickUntil = Date.now() + 300
        event.preventDefault()
      }
      claimed = false
    }
    const onPointerCancel = (event: PointerEvent): void => {
      apply(controller.pointerCancel(event.pointerType))
      if (claimed) suppressClickUntil = Date.now() + 300
      claimed = false
    }

    // 切后台/失焦可能丢失 touchend，reset 自愈，避免 controller.active 永久卡住
    const onVisibilityChange = (): void => {
      if (doc.visibilityState === 'hidden') controller.reset()
    }
    const onWindowBlur = (): void => controller.reset()

    // 捕获阶段吞掉横向手势后的 click（「‹ 引申」等按钮起手滑动时不误触 onClick）
    const onClickCapture = (event: Event): void => {
      if (!isStudyPageEventTarget(event.target)) return
      if (Date.now() >= suppressClickUntil) return
      const start = gestureStartInteractive
      if (!start) return // 手势起点不是按钮/含义行 → 不抑制任何 click（顶部回退等正常工作）
      const target = event.target instanceof Element ? event.target : null
      if (target && (start === target || start.contains(target))) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    // capture 阶段：即使目标元素/中间层调用 stopPropagation 或按钮自己处理，也能先拿到手势
    const passiveTrue: AddEventListenerOptions = { passive: true, capture: true }
    const passiveFalse: AddEventListenerOptions = { passive: false, capture: true }
    doc.addEventListener('touchstart', onTouchStart as EventListener, passiveTrue)
    doc.addEventListener('touchmove', onTouchMove as EventListener, passiveFalse)
    // touchend 在点击抑制时会 preventDefault：必须非 passive，否则 Chrome 报
    // "Unable to preventDefault inside passive event listener invocation"
    doc.addEventListener('touchend', onTouchEnd as EventListener, passiveFalse)
    doc.addEventListener('touchcancel', onTouchCancel as EventListener, passiveTrue)
    doc.addEventListener('pointerdown', onPointerDown as EventListener, passiveTrue)
    doc.addEventListener('pointermove', onPointerMove as EventListener, passiveFalse)
    doc.addEventListener('pointerup', onPointerUp as EventListener, passiveFalse)
    doc.addEventListener('pointercancel', onPointerCancel as EventListener, passiveTrue)
    doc.addEventListener('click', onClickCapture, true)
    doc.addEventListener('visibilitychange', onVisibilityChange)
    if (typeof window !== 'undefined') window.addEventListener('blur', onWindowBlur)

    return () => {
      controller.reset()
      doc.removeEventListener('touchstart', onTouchStart as EventListener, passiveTrue)
      doc.removeEventListener('touchmove', onTouchMove as EventListener, passiveFalse)
      doc.removeEventListener('touchend', onTouchEnd as EventListener, passiveFalse)
      doc.removeEventListener('touchcancel', onTouchCancel as EventListener, passiveTrue)
      doc.removeEventListener('pointerdown', onPointerDown as EventListener, passiveTrue)
      doc.removeEventListener('pointermove', onPointerMove as EventListener, passiveFalse)
      doc.removeEventListener('pointerup', onPointerUp as EventListener, passiveFalse)
      doc.removeEventListener('pointercancel', onPointerCancel as EventListener, passiveTrue)
      doc.removeEventListener('click', onClickCapture, true)
      doc.removeEventListener('visibilitychange', onVisibilityChange)
      if (typeof window !== 'undefined') window.removeEventListener('blur', onWindowBlur)
    }
  }, [enabled])
}
