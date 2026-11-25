/**
 * task-146 F8 · 生成元 → 含义 引申图（每词一条；文字/Mermaid）。
 * 存 Word 本机字段，不进 packItems、不改学习进度；AI apply/reapply 不覆盖。
 */
import { getDb } from './db'
import { saveWordOverlay, saveContentEntitiesChunked } from './content-write-source'
import { wordOverlayOf } from './content-snapshot'
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
  await saveWordOverlay(word)
  return next
}

export async function deleteDerivationMap(wordId: string): Promise<boolean> {
  const word = await getWordOrThrow(wordId)
  if (!word.derivationMap) return false
  delete word.derivationMap
  await saveWordOverlay(word)
  return true
}


export interface SaveDerivationMapsBatchResult { ok: boolean; written: number; revision: number; error?: string }

/**
 * 0.14：批量保存引申图（≤500/批）。
 * - sqlite 模式：content_kv 成功后才更新 IDB cache；失败不回写，返回错误
 * - idb 模式：只写 IDB cache，行为等价原有逐条保存
 */
export async function saveDerivationMapsBatch(
  entries: ReadonlyArray<{ wordId: string; patch: DerivationMapInput }>,
): Promise<SaveDerivationMapsBatchResult> {
  if (entries.length === 0) return { ok: true, written: 0, revision: 0 }
  if (entries.length > 500) return { ok: false, written: 0, revision: 0, error: '单批超过 500 条' }
  const db = getDb()
  const ids = entries.map((entry) => entry.wordId)
  const words = await db.words.bulkGet(ids)
  const rows: Array<{ key: string; kind: 'word-overlay'; json: string; updatedAt: number }> = []
  for (let i = 0; i < entries.length; i += 1) {
    const word = words[i]
    if (!word) return { ok: false, written: 0, revision: 0, error: `单词不存在：${ids[i]}` }
    const patch = entries[i]!.patch
    const existing = word.derivationMap
    const rootLabel = patch.rootLabel !== undefined ? String(patch.rootLabel).trim() : existing?.rootLabel
    const text = patch.text !== undefined ? String(patch.text).trim() : existing?.text
    const mermaid = patch.mermaid !== undefined ? String(patch.mermaid).trim() : existing?.mermaid
    const source: DerivationMap['source'] = patch.source === 'ai' ? 'ai' : patch.source === 'manual' ? 'manual' : existing?.source ?? 'manual'
    const rawLines = patch.lines !== undefined ? patch.lines : existing?.lines
    const maxMeaning = word.meanings.length
    const lines = (rawLines ?? [])
      .map((line) => ({ text: String(line.text ?? '').trim(), meaningIndexes: [...new Set(line.meaningIndexes ?? [])].filter((index) => Number.isInteger(index) && index >= 1 && index <= maxMeaning).sort((a, b) => a - b) }))
      .filter((line) => line.text.length > 0 && line.meaningIndexes.length > 0)
    if (!rootLabel && !text && !mermaid && lines.length === 0) return { ok: false, written: 0, revision: 0, error: '引申图内容不能为空' }
    const map: DerivationMap = {
      ...(rootLabel ? { rootLabel } : {}),
      ...(text ? { text } : {}),
      ...(mermaid ? { mermaid } : {}),
      ...(lines.length > 0 ? { lines } : {}),
      source,
      updatedAt: Date.now(),
    }
    const next: Word = { ...word, derivationMap: map }
    rows.push({ key: `word-overlay:${word.id}`, kind: 'word-overlay', json: JSON.stringify(wordOverlayOf(next as unknown as Record<string, unknown>)), updatedAt: map.updatedAt })
  }
  return saveContentEntitiesChunked(rows)
}
