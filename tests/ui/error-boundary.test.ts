import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { ErrorBoundary } from '../../src/app/ErrorBoundary'

const source = readFileSync(
  fileURLToPath(new URL('../../src/app/ErrorBoundary.tsx', import.meta.url)),
  'utf8',
)

describe('P0：学习页黑屏防护（task-174）', () => {
  it('ErrorBoundary 正常渲染 children，并有错误捕获/记录', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, null, createElement('div', null, 'ok')),
    )
    expect(html).toContain('ok')
    expect(source).toContain('getDerivedStateFromError')
    expect(source).toContain('componentDidCatch')
    expect(source).toContain('__mmLastError')
    expect(source).toContain("addEventListener('error'")
    expect(source).toContain("addEventListener('unhandledrejection'")
    expect(source).toContain("localStorage.setItem('mm.lastError'")
  })

  it('错误回退界面包含错误信息/重试/回首页，不再黑屏', () => {
    expect(source).toContain('页面渲染出错')
    expect(source).toContain('重试')
    expect(source).toContain('回首页')
    expect(source).toContain('window.location.reload()')
  })

  it('StudyPage 的 hooks 在 early return 之前（防止 Rendered more hooks 黑屏）', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    const nativeBack = page.indexOf('registerNativeBack(() => {')
    const loadingReturn = page.indexOf("if (study.phase === 'loading')")
    expect(nativeBack).toBeGreaterThan(0)
    expect(loadingReturn).toBeGreaterThan(0)
    expect(nativeBack).toBeLessThan(loadingReturn)
  })
})
