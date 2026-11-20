/**
 * 品牌配置（公开版：WordC · 词到义；由 tools/sanitize-public.mjs 生成）。
 *
 * 纯常量、无依赖；src/ui 与 src/data 可直接 import。
 * 命名以 `BrandConfig` 为契约，字段集合与私版保持一致（可选字段省略即回退通用文案）。
 */

export interface BrandConfig {
  /** 完整应用名（关于页标题 / 通知 / manifest name） */
  name: string
  /** 短名（manifest short_name / apple-mobile-web-app-title） */
  shortName: string
  /** 关于页副标题（可选；省略回退 description） */
  tagline?: string
  /** 一句话描述（manifest description / 关于页说明） */
  description: string
  /** Android 包名（公开树不含 APK；保留字段以兼容契约） */
  packageId: string
  /** 导出目录显示名（下载/<品牌>） */
  exportFolderLabel: string
  /** 导出/迁移包 metadata.generator 前缀 */
  exportMetadataGenerator: string
  /** 默认在学词库 id */
  defaultDeckId: string
  /** 内置词库 id 列表（公开版只剩大纲） */
  builtinDeckIds: readonly string[]
  /** 是否启用「从MaiMemo导入」 */
  enableMaimemoImport: boolean
  /** 是否官方/私版体验（公开版 false） */
  isOfficialLike: boolean
  /** 关于页背景说明（公开版省略 → 通用文案） */
  backgroundNote?: string
  /** 关于页内置词库说明（公开版省略 → 通用文案） */
  deckNotice?: string
  /** 关于页无隶属关系说明（公开版省略） */
  affiliationNotice?: string
  /** 关于页第三方同步 Token 说明（公开版省略 → 通用文案） */
  tokenNotice?: string
}

export const BRAND: BrandConfig = {
  name: 'WordC',
  shortName: '词到义',
  tagline: '英文 → 中文 · 本地优先 · 离线可用',
  description: '词到义 · 英文到中文的本地优先背单词 PWA，离线可用',
  packageId: 'com.wordc.app',
  exportFolderLabel: '下载/WordC',
  exportMetadataGenerator: 'wordc',
  defaultDeckId: 'kaoyan-2027-dagang',
  builtinDeckIds: ['kaoyan-2027-dagang'],
  enableMaimemoImport: true,
  isOfficialLike: false,
}
