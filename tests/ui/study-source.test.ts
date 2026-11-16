import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const page = readFileSync(fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)), 'utf8')
const nativeBack = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/lib/native-back.ts', import.meta.url)),
  'utf8',
)
const panel = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/DerivationPanel.tsx', import.meta.url)),
  'utf8',
)

describe('task-163 学习页/F8 行为源码回归', () => {
  it('打开右页默认「文字」，不因已有 mermaid 自动切图（A4）', () => {
    expect(page).toContain("setDerivationMode('text')")
    expect(page).not.toContain("setDerivationMode(map.mermaid")
  })

  it('用法弹层打开时隐藏拖拽手柄（A6）', () => {
    expect(page).toContain('derivationUsageOpen')
    expect(page).toContain('!derivationUsageOpen')
  })

  it('Mermaid 全屏压入历史并监听 popstate（手机返回键只关查看器，A5）', () => {
    expect(panel).toContain('pushState')
    expect(panel).toContain('popstate')
    expect(panel).toContain('mmMermaidViewer')
  })

  it('用法弹层开合通知父级（用于手柄层级）', () => {
    expect(panel).toContain('onUsageOpenChange')
    expect(panel).toContain('setUsage(true)')
  })

  it('task-172：注册原生返回键桥，按层级消费（B 弹层/用法/全屏/右页）', () => {
    expect(page).toContain('registerNativeBack')
    expect(nativeBack).toContain('__mmHandleBack')
    expect(panel).toContain('registerNativeBack')
  })

  it('task-172：打开右页初始 50/50（忽略上次持久化），拖拽仅本次会话', () => {
    expect(page).toContain('DERIVATION_WIDTH_DEFAULT')
    expect(page).toContain('setDerivationWidth(DERIVATION_WIDTH_DEFAULT)')
    expect(page).not.toContain('localStorage.setItem(DERIVATION_WIDTH_KEY')
  })

  it('task-181：pointer capture + 打开当帧固定 50 并重置起点，后续才相对拖拽', () => {
    const swipe = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/lib/use-side-panel-swipe.ts', import.meta.url)),
      'utf8',
    )
    expect(swipe).toContain('setPointerCapture')
    expect(swipe).toContain('baseWidth = DERIVATION_WIDTH_DEFAULT')
    expect(swipe).toContain('start.x = event.clientX')
    expect(swipe).toContain('return')
    // task-181：WebView touch fallback
    expect(swipe).toContain('onTouchStart')
    expect(swipe).toContain('onTouchMove')
    expect(swipe).toContain('threshold = 24')
  })

  it('task-183：Mermaid 全屏查看器打开时隐藏拖拽手柄', () => {
    expect(page).toContain('derivationViewerOpen')
    expect(page).toContain('onViewerOpenChange={setDerivationViewerOpen}')
    expect(page).toContain('!derivationViewerOpen &&')
    expect(page).toContain('subwords == null')
    expect(panel).toContain('onViewerOpenChange')
    expect(panel).toContain('setViewer(true)')
  })

  it('task-173：右页保存写入 lines 并回填，w-c 才有当前 c 行', () => {
    expect(page).toContain('...(content.lines ? { lines: content.lines } : {})')
    expect(page).toContain('saved.lines')
    expect(panel).toContain('saving ? \'保存中…\' : \'保存\'')
  })

  it('task-184：注释面手势改为原生 touch 手势（任意位置打开/继续调宽）', () => {
    expect(page).toContain('useStudyPanelGesture')
    expect(page).toContain('containerRef: pageRef')
    expect(page).not.toContain('sideSwipe.onPointerMove')
  })
})
