import type { CoreSenseExampleEntry, CoreSensePhraseEntry } from '../../../core'

export interface CoreSenseViewEntry<T> {
  coreSenseIndex: number
  label: string
  entry?: T
}

/** task-219：label 优先、index 兜底匹配已保存本义内容 */
export function pickCoreSenseEntry<T>(
  views: readonly CoreSenseViewEntry<T>[],
  core: { index: number; label: string },
): T | null {
  return (
    views.find((view) => view.label.trim() === core.label.trim())?.entry ??
    views.find((view) => view.coreSenseIndex === core.index)?.entry ??
    null
  )
}

/** task-219：已保存内容优先于 representative 回退；0 数量直接隐藏 */
export function coreSenseDisplayContent(input: {
  exampleCount: number
  phraseCount: number
  representative: { examples: Array<{ en: string; cn: string }>; phrases: Array<{ en: string; cn: string }> } | null
  savedExamples: CoreSenseExampleEntry | null
  savedPhrases: CoreSensePhraseEntry | null
}): { examples: Array<{ en: string; cn: string }>; phrases: Array<{ en: string; cn: string }> } {
  const examples =
    input.exampleCount > 0
      ? (input.savedExamples?.examples?.length
          ? input.savedExamples.examples
          : (input.representative?.examples ?? [])
        ).slice(0, input.exampleCount)
      : []
  const phrases =
    input.phraseCount > 0
      ? (input.savedPhrases?.phrases?.length
          ? input.savedPhrases.phrases
          : (input.representative?.phrases ?? [])
        ).slice(0, input.phraseCount)
      : []
  return { examples, phrases }
}
