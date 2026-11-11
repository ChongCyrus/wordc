import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'
import { APP_VERSION } from '../../src/app/version'
import AboutPage from '../../src/ui/me/AboutPage'

/** 单一来源：src/app/version.ts 必须与 package.json 的 version 一致（arch 构建时同步） */
const PKG_VERSION = pkg.version

describe('版本号单一来源（task-44）', () => {
  it('APP_VERSION 与 package.json version 一致且格式合法（升版本不用改测试）', () => {
    expect(APP_VERSION).toBe(PKG_VERSION)
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('关于页显示 v{APP_VERSION}，且不出现 0.1.0 旧版本', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(AboutPage, null)),
    )
    expect(html).toContain(`v${APP_VERSION}`)
    expect(html).not.toContain('0.1.0')
  })
})
