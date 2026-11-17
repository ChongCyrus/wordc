/**
 * F10：F8 右页「文字」轻量 Markdown 开关（设置 key 由 data 层提供，默认开）。
 * 渲染实现见 DerivationMarkdown.tsx（安全子集：不渲染原始 HTML）。
 */
import type { SettingsMap } from '../../../core'

export const DERIVATION_MARKDOWN_KEY = 'derivation.markdown'

export function hasDerivationMarkdownSetting(settings: SettingsMap | null | undefined): boolean {
  return (
    settings != null &&
    Object.prototype.hasOwnProperty.call(settings, DERIVATION_MARKDOWN_KEY)
  )
}

/** 缺省/缺失时默认开（task-162：默认开） */
export function readDerivationMarkdown(settings: SettingsMap | null | undefined): boolean {
  const raw = settings
    ? (settings as unknown as Record<string, unknown>)[DERIVATION_MARKDOWN_KEY]
    : undefined
  return raw !== false
}
