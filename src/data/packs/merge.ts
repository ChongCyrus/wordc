/**
 * 内容包合并纯函数（SPEC-CONTENT-PACKS §3.3 / §2.3）：
 * 只补缺、不覆盖；去重 key = 规范化 en / `${type}:${text}`；按上限截断。
 *
 * 幂等：同一内容重复合并不会重复追加（hash/规范化 key 去重）。
 * 不修改入参 Word（返回新对象），由调用方在事务里 put。
 */

import { meaningIdOf } from '../../core'
import type { Example, Mnemonic, Word } from '../../core'
import type { ContentKind, PackItemV1, SkipReason } from './schema'
import { LIMITS, contentHash, mnemonicKey, normalizeEn, normalizeMnemonicType } from './schema'

export interface MergeSkip {
  kind: ContentKind
  reason: SkipReason
  value: string
}

export interface MergeResult {
  word: Word
  changed: boolean
  added: { examples: string[]; phrases: string[]; mnemonics: Array<{ type: Mnemonic['type']; text: string; meaningId?: string }> }
  skipped: MergeSkip[]
}

function cloneWord(word: Word): Word {
  return {
    ...word,
    meanings: word.meanings.map((meaning) => ({
      ...meaning,
      ...(meaning.examples ? { examples: meaning.examples.map((example) => ({ ...example })) } : {}),
    })),
    examples: word.examples.map((example) => ({ ...example })),
    phrases: word.phrases.map((phrase) => ({ ...phrase })),
    mnemonics: word.mnemonics.map((mnemonic) => ({ ...mnemonic })),
  }
}

/**
 * 把一条 pack item 合并进 Word。
 * @param rejectedHashes 该词（+含义）已拒绝内容的 hash 集合（contentRejects）；命中 → skipped:rejected
 * @param meaningIndexOverride 目标含义序号（1 起）——通常来自解析后的 meaningIndex
 */
export function mergeItemIntoWord(
  word: Word,
  item: PackItemV1,
  rejectedHashes: ReadonlySet<string>,
  meaningIndexOverride?: number,
  opts: { allowOverLimit?: boolean } = {},
): MergeResult {
  const next = cloneWord(word)
  const headwordLower = word.headwordLower
  const skipped: MergeSkip[] = []
  const added = { examples: [] as string[], phrases: [] as string[], mnemonics: [] as Array<{ type: Mnemonic['type']; text: string; meaningId?: string }> }
  let changed = false

  // —— examples：含义级（item.meaningIndex 或 override）或词级 ——
  const exampleMeaningIndex = meaningIndexOverride ?? item.meaningIndex
  if ((item.examples ?? []).length > 0) {
    if (exampleMeaningIndex != null) {
      const meaning = next.meanings[exampleMeaningIndex - 1]
      if (!meaning) {
        skipped.push({ kind: 'examples', reason: 'unknown-meaning', value: `meaningIndex=${exampleMeaningIndex}` })
      } else {
        const list: Example[] = meaning.examples ? meaning.examples.map((example) => ({ ...example })) : []
        const existing = new Set(list.map((example) => normalizeEn(example.en)))
        for (const example of item.examples ?? []) {
          const en = String(example.en ?? '').trim()
          if (!en) continue
          const hash = contentHash('examples', headwordLower, exampleMeaningIndex, en)
          if (rejectedHashes.has(hash)) {
            skipped.push({ kind: 'examples', reason: 'rejected', value: en })
            continue
          }
          if (existing.has(normalizeEn(en))) {
            skipped.push({ kind: 'examples', reason: 'duplicate', value: en })
            continue
          }
          if (!opts.allowOverLimit && list.length >= LIMITS.meaningExamples) {
            skipped.push({ kind: 'examples', reason: 'limit', value: en })
            continue
          }
          list.push({ en, cn: String(example.cn ?? '').trim() })
          existing.add(normalizeEn(en))
          added.examples.push(en)
          changed = true
        }
        if (list.length > (meaning.examples?.length ?? 0)) meaning.examples = list
      }
    } else {
      const list = next.examples
      const existing = new Set(list.map((example) => normalizeEn(example.en)))
      for (const example of item.examples ?? []) {
        const en = String(example.en ?? '').trim()
        if (!en) continue
        const hash = contentHash('examples', headwordLower, undefined, en)
        if (rejectedHashes.has(hash)) {
          skipped.push({ kind: 'examples', reason: 'rejected', value: en })
          continue
        }
        if (existing.has(normalizeEn(en))) {
          skipped.push({ kind: 'examples', reason: 'duplicate', value: en })
          continue
        }
        if (!opts.allowOverLimit && list.length >= LIMITS.wordExamples) {
          skipped.push({ kind: 'examples', reason: 'limit', value: en })
          continue
        }
        list.push({ en, cn: String(example.cn ?? '').trim() })
        existing.add(normalizeEn(en))
        added.examples.push(en)
        changed = true
      }
    }
  }

  // —— phrases：phrase.meaningIndex > 条目级 meaningIndex > 词级 ——
  for (const phrase of item.phrases ?? []) {
    const en = String(phrase.en ?? '').trim()
    if (!en) continue
    const phraseMeaningIndex = phrase.meaningIndex ?? item.meaningIndex
    const hash = contentHash('phrases', headwordLower, phraseMeaningIndex, en)
    if (rejectedHashes.has(hash)) {
      skipped.push({ kind: 'phrases', reason: 'rejected', value: en })
      continue
    }
    let meaningId: string | undefined
    if (phraseMeaningIndex != null) {
      if (!next.meanings[phraseMeaningIndex - 1]) {
        skipped.push({ kind: 'phrases', reason: 'unknown-meaning', value: `${en}（meaningIndex=${phraseMeaningIndex}）` })
        continue
      }
      meaningId = meaningIdOf(word.id, phraseMeaningIndex)
    }
    const existing = new Set(next.phrases.map((item2) => normalizeEn(item2.en)))
    if (existing.has(normalizeEn(en))) {
      skipped.push({ kind: 'phrases', reason: 'duplicate', value: en })
      continue
    }
    if (!opts.allowOverLimit && next.phrases.length >= LIMITS.phrases) {
      skipped.push({ kind: 'phrases', reason: 'limit', value: en })
      continue
    }
    const nextPhrase = meaningId ? { en, cn: String(phrase.cn ?? '').trim(), meaningId } : { en, cn: String(phrase.cn ?? '').trim() }
    next.phrases.push(nextPhrase)
    added.phrases.push(en)
    changed = true
  }

  // —— mnemonics：按含义归属（task-128；无 meaningIndex 时词级兼容） ——
  if ((item.mnemonics ?? []).length > 0) {
    const mnemonicMeaningIndex = meaningIndexOverride ?? item.meaningIndex
    const meaningId =
      mnemonicMeaningIndex != null ? meaningIdOf(word.id, mnemonicMeaningIndex) : undefined
    if (mnemonicMeaningIndex != null && !next.meanings[mnemonicMeaningIndex - 1]) {
      skipped.push({ kind: 'mnemonics', reason: 'unknown-meaning', value: `meaningIndex=${mnemonicMeaningIndex}` })
    } else {
      const existing = new Set(
        next.mnemonics.map((mnemonic) => mnemonicKey({ type: mnemonic.type, text: mnemonic.text, meaningId: mnemonic.meaningId })),
      )
      for (const mnemonic of item.mnemonics ?? []) {
        const text = String(mnemonic.text ?? '').trim()
        if (!text) continue
        const type = normalizeMnemonicType(mnemonic.type)
        const key = mnemonicKey({ type, text, meaningId })
        const hash = contentHash('mnemonics', headwordLower, mnemonicMeaningIndex, key)
        if (rejectedHashes.has(hash)) {
          skipped.push({ kind: 'mnemonics', reason: 'rejected', value: key })
          continue
        }
        if (existing.has(key)) {
          skipped.push({ kind: 'mnemonics', reason: 'duplicate', value: key })
          continue
        }
        if (!opts.allowOverLimit && next.mnemonics.length >= LIMITS.mnemonics) {
          skipped.push({ kind: 'mnemonics', reason: 'limit', value: key })
          continue
        }
        next.mnemonics.push({ type, text, ...(meaningId ? { meaningId } : {}) })
        existing.add(key)
        added.mnemonics.push({ type, text, ...(meaningId ? { meaningId } : {}) })
        changed = true
      }
    }
  }

  return { word: next, changed, added, skipped }
}
