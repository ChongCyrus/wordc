/**
 * task-184：手势接线源码审计（自动化证据）
 * - 学习页不再把 React pointer 作为右页手势主路径，改为 useStudyPanelGesture 原生监听；
 * - touchmove 必须 passive:false 才可 preventDefault；
 * - 触屏 pointer 事件必须忽略（单一来源），pointercancel 不清 touch 手势；
 * - 纵向滚动/按钮不拦截；右页打开时禁用「右滑回退」避免双动作。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const page = readFileSync(fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)), 'utf8')
const hook = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/lib/use-study-panel-gesture.ts', import.meta.url)),
  'utf8',
)
const controller = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/lib/panel-gesture.ts', import.meta.url)),
  'utf8',
)
const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

describe('task-184 源码级审计：右页手势接线', () => {
  it('StudyPage 使用新 hook（页面根容器 capture，覆盖右缘按钮/空白），不再用旧 sideSwipe pointer 主路径', () => {
    expect(page).toContain('useStudyPanelGesture')
    expect(page).toContain('containerRef: pageRef')
    expect(page).not.toContain('useSidePanelSwipe(')
    expect(page).not.toContain('sideSwipe.onPointerMove')
    expect(page).toContain('isOpen: derivationPanelOpen')
    // task-188：取消右滑回退上一词手势（只保留顶部「<」按钮；右滑仅收窄/关闭右页）
    expect(page).not.toContain('useSwipeBack')
    expect(page).not.toContain('swipe.handlers')
    expect(page).toContain('onResize')
  })

  it('原生 touchmove 以 passive:false 绑定，并只在横向手势 preventDefault', () => {
    // capture 阶段 + touchmove passive:false：右缘按钮/中间层 stopPropagation 也能先拿到手势
    expect(hook).toContain('capture: true')
    expect(hook).toContain('passive: false')
    // task-195：监听绑 document capture，根元素卸载/重挂载后仍生效
    expect(hook).toContain('const doc = typeof document')
    expect(hook).toContain("doc.addEventListener('touchmove', onTouchMove as EventListener, passiveFalse)")
    expect(hook).toContain("doc.addEventListener('pointerup', onPointerUp as EventListener, passiveFalse)")
    expect(hook).toContain("doc.addEventListener('touchstart', onTouchStart as EventListener, passiveTrue)")
    expect(hook).toContain(".closest('.study-page')")
    expect(hook).not.toContain('const el = containerRef.current')
    expect(hook).toContain('}, [enabled])')
    expect(hook).toContain('if (result.preventDefault && event.cancelable) event.preventDefault()')
    // 横向手势后抑制 click（从「‹ 引申」按钮起手滑动时不误触 onClick）
    expect(hook).toContain('suppressClickUntil')
    expect(hook).toContain('onClickCapture')
    // 只抑制手势起点元素（按钮/含义行）的 click，不能误伤顶部回退
    expect(hook).toContain('gestureStartInteractive')
    expect(hook).toContain('start.contains(target)')
    // 非横向不动 scroll；触摸 pointer 全部忽略（避免双路径）
    expect(hook).toContain("if (event.pointerType === 'touch') return")
  })

  it('pointercancel 不影响 touch 手势；touch 走 controller 而非 React 合成事件', () => {
    expect(hook).toContain('controller.pointerCancel(event.pointerType)')
    expect(hook).toContain('controller.touchMove(')
    expect(hook).toContain('controller.touchEnd(')
    expect(hook).toContain('controller.touchCancel()')
    expect(controller).toContain("pointerType === 'touch'")
    expect(controller).toContain('touchMove')
    // 1:1 跟手：startWidth + rawWidth；不设打开固定 50/不重置锚点
    expect(controller).toContain('startWidth')
    expect(controller).toContain('rawWidth')
    expect(controller).toContain('clampLiveDerivationWidth')
    expect(controller).not.toContain('state.anchorX')
  })

  it('task-188：取消右滑回退手势（顶部「<」仍保留）', () => {
    expect(page).not.toContain('useSwipeBack')
    expect(page).not.toContain('swipe.handlers')
    expect(page).toContain('onBack={detailMode ? undefined : canGoBack ? handleGoBack : undefined}')
  })

  it('CSS：注释面纵向可滚、横向不滚；面板宽度用同一 CSS 变量', () => {
    expect(css).toContain('.study-page--annotation .study-body')
    expect(css).toContain('touch-action: pan-y')
    expect(css).toContain('overscroll-behavior-x: none')
    expect(css).toContain('--derivation-panel-width')
    expect(css).toContain('overflow-x: hidden')
    // 右缘「‹ 引申」按钮 touch-action:none，滑动由页面根 capture 接管
    expect(css).toContain('.derivation-handle')
    expect(css).toContain('touch-action: none')
    // task-186：handle 始终渲染，打开时仅 CSS 隐藏（手势中 target 不被卸载）
    expect(page).toContain('derivation-handle--hidden')
    expect(page).toContain('aria-hidden={derivationPanelOpen}')
    // task-187：灵敏度接入（默认 1.0，0.2–3.0）
    expect(page).toContain('readSwipeSensitivity')
    expect(page).toContain('sensitivity: readSwipeSensitivity')
    expect(css).toContain('.derivation-handle--hidden')
    expect(css).toContain('.derivation-panel')
    const panelRule = css.slice(css.indexOf('.derivation-panel {'), css.indexOf('.derivation-panel {') + 400)
    expect(panelRule).toContain('touch-action: pan-y')
    expect(panelRule).toContain('overscroll-behavior-x: none')
  })
})
