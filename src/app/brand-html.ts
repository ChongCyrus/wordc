/**
 * index.html 品牌占位符注入（task-57）：HTML 里不硬编码品牌字串，
 * 由 vite `transformIndexHtml` 在构建时用 BRAND 替换 `%BRAND_*%`。
 * 纯函数、无依赖，便于单测；私版输出与旧 index.html 逐字一致。
 */
import { BRAND, type BrandConfig } from './brand'

export function injectBrandHtml(html: string, brand: BrandConfig = BRAND): string {
  return html
    .replaceAll('%BRAND_NAME%', brand.name)
    .replaceAll('%BRAND_SHORT_NAME%', brand.shortName)
    .replaceAll('%BRAND_DESCRIPTION%', brand.description)
    .replaceAll('%BRAND_TAGLINE%', brand.tagline ?? brand.description)
}
