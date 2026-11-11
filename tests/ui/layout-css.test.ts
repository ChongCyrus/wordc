import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；本测试只在 vitest node 环境使用 Node 内置模块（同 dev-data 测试做法）
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/app/styles/global.css', import.meta.url)),
  'utf8',
)

/** 布局/跨机型 CSS 回归（task-46）：直接断言 global.css 的关键规则，避免被改回去。 */

function ruleBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `找不到规则：${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return css.slice(start, end + 1)
}

describe('跨机型布局 CSS（task-46）', () => {
  it('.app-shell 有 vh 兜底后再用 dvh（旧 WebView 不支持 dvh 时底栏仍固定）', () => {
    const block = ruleBlock('.app-shell')
    const vh = block.indexOf('height: 100vh;')
    const dvh = block.indexOf('height: 100dvh;')
    expect(vh).toBeGreaterThanOrEqual(0)
    expect(dvh).toBeGreaterThan(vh)
  })

  it('body 的 min-height 同样有 vh 兜底', () => {
    const block = ruleBlock('  body')
    expect(block).toContain('min-height: 100vh;')
    expect(block).toContain('min-height: 100dvh;')
  })

  it('.tabbar 贴底双保险（sticky + bottom:0 + z-index）且保留安全区变量', () => {
    const block = ruleBlock('.tabbar')
    expect(block).toContain('position: sticky;')
    expect(block).toContain('bottom: 0;')
    expect(block).toContain('z-index: var(--mm-z-tabbar);')
    expect(block).toContain('var(--mm-safe-bottom)')
  })

  it('.app-main 有 min-height:0，避免内容把底栏挤出屏幕', () => {
    expect(ruleBlock('.app-main')).toContain('min-height: 0;')
  })

  it('.mm-section-band 上下间距对称（16px），卡片不再紧贴标题栏底端', () => {
    const block = ruleBlock('.mm-section-band')
    // margin: 16px calc(-1 * var(--mm-page-x)) 16px;
    expect(block).toMatch(/margin:\s*16px[^;]*16px;/)
    expect(block).toContain('height: var(--mm-section-band-h);')
    // 首个 band 仍保持较小上间距
    expect(ruleBlock('.mm-section-band:first-child')).toContain('margin-top: 8px;')
  })

  it('弹层 max-height 有 vh 兜底（旧内核不支持 dvh 时不至于占满屏）', () => {
    expect(ruleBlock('.mm-dialog')).toMatch(/max-height: 80vh;\s*max-height: 80dvh;/)
    expect(ruleBlock('.mm-sheet')).toMatch(/max-height: 86vh;\s*max-height: 86dvh;/)
  })
})
