import type { SenseMnemonic } from '../../../data'

export interface SenseCoreLike {
  label: string
  note?: string
  origin?: string
}

export interface SenseMnemonicViewLike {
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  mnemonic?: SenseMnemonic
  match?: 'label' | 'index'
}

/**
 * task-205 UI 侧快速回填：直接由当前 coreSenses + 原始 senseMnemonics 计算，
 * 不走可能挂起的 `listSenseMnemonicViews`（其内部 getEffectiveContent 问题由 data 修复）。
 * 匹配：label 优先，index 兜底；对不上的进 stale。
 */
export function buildSenseMnemonicViews(
  coreSenses: readonly SenseCoreLike[],
  stored: readonly SenseMnemonic[],
): { current: SenseMnemonicViewLike[]; stale: SenseMnemonic[] } {
  const used = new Set<number>()
  const current = coreSenses.map((sense, index) => {
    const coreSenseIndex = index + 1
    const label = sense.label.trim()
    let matchIndex = stored.findIndex(
      (entry, entryIndex) =>
        !used.has(entryIndex) && entry.label.trim() === label,
    )
    let matchType: 'label' | 'index' | undefined = matchIndex >= 0 ? 'label' : undefined
    if (matchIndex < 0) {
      matchIndex = stored.findIndex(
        (entry, entryIndex) => !used.has(entryIndex) && entry.coreSenseIndex === coreSenseIndex,
      )
      if (matchIndex >= 0) matchType = 'index'
    }
    const mnemonic = matchIndex >= 0 ? stored[matchIndex] : undefined
    if (matchIndex >= 0) used.add(matchIndex)
    return {
      coreSenseIndex,
      label: sense.label,
      ...(sense.note ? { gloss: sense.note } : {}),
      ...(sense.origin ? { origin: sense.origin } : {}),
      ...(mnemonic ? { mnemonic } : {}),
      ...(matchType ? { match: matchType } : {}),
    }
  })
  const stale = stored.filter((_, index) => !used.has(index))
  return { current, stale }
}
