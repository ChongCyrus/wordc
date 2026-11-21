import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToastProvider } from '../../src/app/toast'
import { ContentPackImportSection } from '../../src/ui/me/ContentPackImportSection'

describe('导入内容包入口（task-71）', () => {
  it('默认接 data.importContentPack：按钮可用并说明多选', () => {
    const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(ContentPackImportSection, {})))
    expect(html).toContain('导入内容包')
    expect(html).toContain('.pack.json')
    expect(html).toContain('多选')
    expect(html).toContain('选择文件')
    expect(html).not.toContain('disabled')
  })

  it('支持测试注入 onImportPack', () => {
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(ContentPackImportSection, {
          onImportPack: async () => ({ imported: 1, failed: 0 }),
        }),
      ),
    )
    expect(html).toContain('选择文件')
  })
})
