/**
 * F7：白板面显示各 c 英文词组（设置 `board.showMeaningPhrases`，默认关）。
 * 数据层 key 未落地时设置页自动隐藏该行；读取缺失按 false。
 */
import type { SettingsMap } from '../../core'

export const BOARD_SHOW_MEANING_PHRASES_KEY = 'board.showMeaningPhrases'

export function hasBoardShowMeaningPhrasesSetting(
  settings: SettingsMap | null | undefined,
): boolean {
  return (
    settings != null &&
    Object.prototype.hasOwnProperty.call(settings, BOARD_SHOW_MEANING_PHRASES_KEY)
  )
}

export function readBoardShowMeaningPhrases(
  settings: SettingsMap | null | undefined,
): boolean {
  const raw = settings
    ? (settings as unknown as Record<string, unknown>)[BOARD_SHOW_MEANING_PHRASES_KEY]
    : undefined
  return raw === true
}
