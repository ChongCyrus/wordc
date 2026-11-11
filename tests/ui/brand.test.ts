// @ts-expect-error 项目未装 @types/node；本测试只在 vitest node 环境使用 Node 内置模块
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error 同上
import { join } from 'node:path'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { BRAND, type BrandConfig } from '../../src/app/brand'
import { injectBrandHtml } from '../../src/app/brand-html'
import { APP_NAME } from '../../src/app/version'
import { EXPORT_FOLDER_LABEL } from '../../src/app/utils/files'
import AboutPage from '../../src/ui/me/AboutPage'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 品牌名硬编码检测（task-62）：
 * - 私版品牌是中文（如「WordC」）→ 直接子串匹配；
 * - 公开版 sanitize 后品牌名是拉丁词（WordC）→ 必须按“独立词”匹配，
 *   避免把 `TodayWordCategory` / `ratedWordCount` 这类标识符误判成品牌泄漏。
 * - 功能性文案（「墨墨/从墨墨导入/墨墨 Token」）**允许**出现在 src/ui、src/app/hooks 等允许路径，
 *   本测试只禁止“品牌名本身”硬编码，brand.ts 除外。
 */
export function brandNameOccurrences(text: string, brandName: string = BRAND.name): number {
  const escaped = brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 中日韩字符：直接子串；拉丁/ASCII：前后不能是标识符字符
  const pattern = /[\u4e00-\u9fff]/.test(brandName)
    ? new RegExp(escaped, 'g')
    : new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'g')
  return (text.match(pattern) ?? []).length
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

describe('品牌配置（task-57）', () => {
  it('BRAND 字段完整且类型/关系正确（公开版 sanitize 只覆盖本文件）', () => {
    for (const key of [
      'name',
      'shortName',
      'description',
      'packageId',
      'exportFolderLabel',
      'exportMetadataGenerator',
      'defaultDeckId',
    ] as const) {
      expect(BRAND[key], key).toBeTruthy()
      expect(typeof BRAND[key]).toBe('string')
    }
    expect(Array.isArray(BRAND.builtinDeckIds)).toBe(true)
    expect(BRAND.builtinDeckIds.length).toBeGreaterThanOrEqual(1)
    expect(BRAND.builtinDeckIds).toContain(BRAND.defaultDeckId)
    expect(typeof BRAND.enableMaimemoImport).toBe('boolean')
    expect(typeof BRAND.isOfficialLike).toBe('boolean')
    // 关系断言（不硬编码私版名称，公开版覆盖 brand.ts 后仍通过）
    expect(APP_NAME).toBe(BRAND.name)
    expect(EXPORT_FOLDER_LABEL).toBe(BRAND.exportFolderLabel)
  })

  it('关于页使用 BRAND 名称/副标题与品牌说明（私版输出不变）', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(AboutPage, null)),
    )
    expect(html).toContain(BRAND.name)
    expect(html).toContain(BRAND.tagline ?? BRAND.description)
    if (BRAND.backgroundNote) expect(html).toContain(BRAND.backgroundNote)
    if (BRAND.deckNotice) expect(html).toContain(BRAND.deckNotice)
    if (BRAND.affiliationNotice) expect(html).toContain(BRAND.affiliationNotice)
    if (BRAND.tokenNotice) expect(html).toContain(BRAND.tokenNotice)
  })

  it('公开版品牌（isOfficialLike=false，省略第三方说明字段）→ 关于页无「墨墨/受限商业词表」', () => {
    const publicBrand: BrandConfig = {
      name: 'WordC',
      shortName: '词到义',
      description: '词到义 · 本地优先背单词 PWA',
      packageId: 'com.wordc.app',
      exportFolderLabel: '下载/WordC',
      exportMetadataGenerator: 'wordc',
      defaultDeckId: 'kaoyan-2027-dagang',
      builtinDeckIds: ['kaoyan-2027-dagang'],
      enableMaimemoImport: true,
      isOfficialLike: false,
    }
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(AboutPage, { brand: publicBrand })),
    )
    expect(html).toContain('WordC')
    expect(html).not.toContain('墨墨')
    expect(html).not.toContain('受限商业词表')
    expect(html).toContain('FEATURES-COMPLIANCE')
    expect(html).toContain('THIRD-PARTY-NOTICES')
    expect(html).toContain('API Token（如填写）')
  })

  it('index.html 不含硬编码品牌：占位符由 injectBrandHtml 注入', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    expect(html).toContain('%BRAND_NAME%')
    expect(html).not.toContain('WordC')
    const injected = injectBrandHtml(html)
    expect(injected).toContain(`<title>${BRAND.name}</title>`)
    expect(injected).toContain(BRAND.shortName)
    expect(injected).not.toContain('%BRAND_')
  })

  it('vite.config.ts manifest 从 BRAND 读取（无硬编码品牌字串）', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    expect(config).toContain('name: BRAND.name')
    expect(config).toContain('short_name: BRAND.shortName')
    expect(config).toContain('description: BRAND.description')
    expect(config).not.toContain('WordC')
  })

  it('源码无品牌名硬编码遗留（brand.ts 除外；功能性「墨墨」文案允许）', () => {
    const files = walk(join(ROOT, 'src'))
    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith(join('src', 'app', 'brand.ts'))) continue
      const text = readFileSync(file, 'utf8')
      if (brandNameOccurrences(text) > 0) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('品牌名检测不会误伤含品牌名的标识符（公开版 WordC 场景）', () => {
    expect(brandNameOccurrences('export type TodayWordCategory = \'review\'')).toBe(0)
    expect(brandNameOccurrences('const ratedWordCount = 1')).toBe(0)
    expect(brandNameOccurrences("const name = 'WordC'", 'WordC')).toBe(1)
    expect(brandNameOccurrences('品牌：WordC', 'WordC')).toBe(1)
  })

  it('功能性导入文案允许出现在导入相关路径（白名单）', () => {
    const data = readFileSync(
      join(ROOT, 'src', 'app', 'hooks', 'useMaimemoTransport.ts'),
      'utf8',
    )
    // 功能性文案（墨墨/从墨墨导入/墨墨 Token）允许；但不得包含品牌名硬编码
    expect(data.length).toBeGreaterThan(0)
    expect(brandNameOccurrences(data)).toBe(0)
  })
})
