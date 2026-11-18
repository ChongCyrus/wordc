/**
 * task-146 F8 · 生成元 → 含义 引申图（每词一条；文字/Mermaid）。
 * 存 Word 本机字段，不进 packItems、不改学习进度；AI apply/reapply 不覆盖。
 */
import { getDb } from './db'
import type { DerivationMap, Word } from '../core/types'

export type { DerivationMap } from '../core/types'

export interface DerivationMapInput {
  rootLabel?: string
  text?: string
  mermaid?: string
  /** task-164：AI 文字逐行 → c 索引映射（1 起） */
  lines?: Array<{ text: string; meaningIndexes: number[] }>
  /** 缺省沿用已有 source；新建默认 manual；AI 生成预览保存时传 'ai' */
  source?: 'manual' | 'ai'
}

async function getWordOrThrow(wordId: string): Promise<Word> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  return word
}

export async function getDerivationMap(wordId: string): Promise<DerivationMap | null> {
  const word = await getWordOrThrow(wordId)
  return word.derivationMap ?? null
}

/** 保存/更新引申图（patch 中显式空串会移除该字段；至少保留一个内容字段） */
export async function saveDerivationMap(wordId: string, patch: DerivationMapInput): Promise<DerivationMap> {
  const word = await getWordOrThrow(wordId)
  const existing = word.derivationMap
  const rootLabel = patch.rootLabel !== undefined ? String(patch.rootLabel).trim() : existing?.rootLabel
  const text = patch.text !== undefined ? String(patch.text).trim() : existing?.text
  const mermaid = patch.mermaid !== undefined ? String(patch.mermaid).trim() : existing?.mermaid
  const source: DerivationMap['source'] = patch.source === 'ai' ? 'ai' : patch.source === 'manual' ? 'manual' : existing?.source ?? 'manual'
  // task-164：lines 逐行→c 映射；meaningIndexes 过滤非法/去重，每行至少 1 个有效 c
  const rawLines = patch.lines !== undefined ? patch.lines : existing?.lines
  const maxMeaning = word.meanings.length
  const lines = (rawLines ?? [])
    .map((line) => ({
      text: String(line.text ?? '').trim(),
      meaningIndexes: [...new Set(line.meaningIndexes ?? [])]
        .filter((index) => Number.isInteger(index) && index >= 1 && index <= maxMeaning)
        .sort((a, b) => a - b),
    }))
    .filter((line) => line.text.length > 0 && line.meaningIndexes.length > 0)
  if (!rootLabel && !text && !mermaid && lines.length === 0) throw new Error('引申图内容不能为空')
  const next: DerivationMap = {
    ...(rootLabel ? { rootLabel } : {}),
    ...(text ? { text } : {}),
    ...(mermaid ? { mermaid } : {}),
    ...(lines.length > 0 ? { lines } : {}),
    source,
    updatedAt: Date.now(),
  }
  word.derivationMap = next
  await getDb().words.put(word)
  return next
}

export async function deleteDerivationMap(wordId: string): Promise<boolean> {
  const word = await getWordOrThrow(wordId)
  if (!word.derivationMap) return false
  delete word.derivationMap
  await getDb().words.put(word)
  return true
}
