/** 0.3.98/task-283：词根词缀词源分解（手动优先；AI 不覆盖 manual） */
import { getDb } from './db'
import { recordContentOpsAfterTx } from './content-event-log'
import { saveWordOverlay } from './content-write-source'
import type { RootEtymology, RootEtymologyPart, Word } from '../core/types'

export const ROOT_ETYMOLOGY_VERSION = '0.3.98'

export interface RootEtymologyDraft {
  parts: RootEtymologyPart[]
  etymology?: string
  composition?: string
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

/** 规范化 parts（去空、合法 type、去重） */
export function normalizeRootEtymologyParts(raw: readonly unknown[] | undefined): RootEtymologyPart[] {
  const types = new Set(['prefix', 'root', 'suffix', 'other'])
  const seen = new Set<string>()
  const parts: RootEtymologyPart[] = []
  for (const item of raw ?? []) {
    const row = item as Partial<RootEtymologyPart> | null
    const type = row?.type
    const text = cleanText(row?.text)
    const meaning = cleanText(row?.meaning)
    if (!types.has(String(type)) || !text || !meaning) continue
    const key = `${type}|${text}|${meaning}`
    if (seen.has(key)) continue
    seen.add(key)
    parts.push({
      type: type as RootEtymologyPart['type'],
      text,
      meaning,
      ...(cleanText(row?.note) ? { note: cleanText(row?.note) } : {}),
    })
  }
  return parts
}

/** 严格解析 AI 输出；无法确认时允许空 parts（需 note/etymology 说明） */
export function validateRootEtymologyDraft(raw: unknown): RootEtymologyDraft {
  const obj = raw as { parts?: unknown; etymology?: unknown; composition?: unknown } | null | undefined
  if (!obj || typeof obj !== 'object') throw new Error('AI 返回不是对象')
  if (!Array.isArray(obj.parts)) throw new Error('AI 返回缺少 parts 数组')
  // 0.3.98 补充：每个 part 的 meaning 必填；不能只存 text/悄悄过滤
  for (const [index, item] of obj.parts.entries()) {
    const row = item as Partial<RootEtymologyPart> | null
    if (!row || typeof row !== 'object') throw new Error(`parts[${index}] 不是对象`)
    if (!cleanText(row.text)) throw new Error(`parts[${index}].text 不能为空`)
    if (!cleanText(row.meaning)) throw new Error(`parts[${index}].meaning 不能为空`)
  }
  const parts = normalizeRootEtymologyParts(obj.parts)
  const etymology = cleanText(obj.etymology)
  const composition = cleanText(obj.composition)
  if (parts.length === 0 && !etymology) {
    throw new Error('无法确认词源时需返回空 parts + etymology 说明，不能编造')
  }
  return {
    parts,
    ...(etymology ? { etymology } : {}),
    ...(composition ? { composition } : {}),
  }
}

export async function getRootEtymology(wordId: string): Promise<RootEtymology | null> {
  const word = await getDb().words.get(wordId)
  return word?.rootEtymology ?? null
}

export interface SaveRootEtymologyOptions {
  source?: 'ai' | 'manual'
  /** AI 遇到 manual 时不覆盖（默认 true） */
  preserveManual?: boolean
  model?: string
  now?: number
  checkedAt?: number
  version?: string
}

/** 保存词源分解；AI 保存默认不覆盖 manual。手动保存永远覆盖并标 manual。 */
export async function saveRootEtymology(
  wordId: string,
  draft: { parts: readonly unknown[]; etymology?: string; composition?: string },
  opts: SaveRootEtymologyOptions = {},
): Promise<RootEtymology | null> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  const source = opts.source ?? 'manual'
  if (source === 'ai' && opts.preserveManual !== false && word.rootEtymology?.source === 'manual') {
    return word.rootEtymology
  }
  const parts = normalizeRootEtymologyParts(draft.parts)
  const etymology = cleanText(draft.etymology)
  const composition = cleanText(draft.composition)
  if (parts.length === 0 && !etymology) {
    // 空结果只记录 checkedAt，不写空结构
    const next: Word = {
      ...word,
      rootEtymologyCheckedAt: opts.checkedAt ?? opts.now ?? Date.now(),
      rootEtymologyVersion: opts.version ?? ROOT_ETYMOLOGY_VERSION,
    }
    await saveWordOverlay(next)
    void recordContentOpsAfterTx([{ type: 'wordOverlay', key: next.id, op: 'upsert' }])
    return null
  }
  const now = opts.now ?? Date.now()
  const entry: RootEtymology = {
    parts,
    ...(etymology ? { etymology } : {}),
    ...(composition ? { composition } : {}),
    source,
    updatedAt: now,
    ...(opts.model ? { model: opts.model } : {}),
  }
  const savedWord = {
    ...word,
    rootEtymology: entry,
    rootEtymologyCheckedAt: opts.checkedAt ?? now,
    rootEtymologyVersion: opts.version ?? ROOT_ETYMOLOGY_VERSION,
  }
  await saveWordOverlay(savedWord)
  void recordContentOpsAfterTx([{ type: 'wordOverlay', key: word.id, op: 'upsert' }])
  return entry
}

/** 手动删除词源分解（保留 checkedAt，避免自动重复花费；可再手动保存） */
export async function deleteRootEtymology(wordId: string): Promise<void> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return
  const next = { ...word }
  delete next.rootEtymology
  await saveWordOverlay(next)
  void recordContentOpsAfterTx([{ type: 'wordOverlay', key: wordId, op: 'upsert' }])
}

/** 批量应用 AI 结果：保留 manual；成功词 stamp checkedAt/version */
export interface RootEtymologyApplyItem {
  wordId: string
  parts?: readonly unknown[]
  etymology?: string
  composition?: string
  error?: string
}

export async function applyRootEtymologyResults(
  items: readonly RootEtymologyApplyItem[],
  opts: { now?: number; version?: string; model?: string } = {},
): Promise<{ checked: number; saved: number; skippedManual: number; failed: Array<{ wordId: string; error: string }> }> {
  const failed: Array<{ wordId: string; error: string }> = []
  let checked = 0
  let saved = 0
  let skippedManual = 0
  for (const item of items) {
    if (item.error) {
      failed.push({ wordId: item.wordId, error: item.error })
      continue
    }
    try {
      const existing = await getDb().words.get(item.wordId)
      if (!existing) throw new Error(`单词不存在：${item.wordId}`)
      if (existing.rootEtymology?.source === 'manual') {
        skippedManual += 1
        continue
      }
      const result = await saveRootEtymology(
        item.wordId,
        {
          parts: item.parts ?? [],
          ...(item.etymology ? { etymology: item.etymology } : {}),
          ...(item.composition ? { composition: item.composition } : {}),
        },
        { source: 'ai', preserveManual: true, ...opts },
      )
      checked += 1
      if (result) saved += 1
    } catch (error) {
      failed.push({ wordId: item.wordId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { checked, saved, skippedManual, failed }
}

// ============ 批量候选（选中/筛选/增量） ============

export interface RootEtymologyCandidatesInput {
  source: 'selected' | 'deck' | 'filtered'
  wordIds?: readonly string[]
  deckId?: string
  query?: string
  status?: 'unchecked' | 'checked' | 'all'
  limit?: number
  offset?: number
}

export interface RootEtymologyCandidateWord {
  word: Word
  status: 'unchecked' | 'checked'
  checkedAt?: number
  version?: string
}

export async function getRootEtymologyCandidates(input: RootEtymologyCandidatesInput): Promise<{
  total: number
  words: RootEtymologyCandidateWord[]
  counts: { all: number; unchecked: number; checked: number }
  limit: number
  offset: number
}> {
  const db = getDb()
  const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 50)))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  let rows: Word[]
  if (input.source === 'selected') {
    const ids = [...new Set((input.wordIds ?? []).filter(Boolean))]
    const found = await db.words.bulkGet(ids)
    rows = ids.map((id) => found.find((word) => word?.id === id)).filter((word): word is Word => Boolean(word))
  } else {
    if (!input.deckId) return { total: 0, words: [], counts: { all: 0, unchecked: 0, checked: 0 }, limit, offset }
    rows = await db.words.where('deckId').equals(input.deckId).toArray()
    const query = input.query?.trim().toLowerCase()
    if (query) {
      rows = rows.filter(
        (word) => word.headwordLower.includes(query) || word.meanings.some((meaning) => meaning.cn.toLowerCase().includes(query)),
      )
    }
  }
  const withStatus = rows.map((word) => {
    const checked =
      word.rootEtymologyCheckedAt != null &&
      (word.rootEtymologyVersion == null || word.rootEtymologyVersion === ROOT_ETYMOLOGY_VERSION)
    return {
      word,
      status: checked ? ('checked' as const) : ('unchecked' as const),
      ...(word.rootEtymologyCheckedAt != null ? { checkedAt: word.rootEtymologyCheckedAt } : {}),
      ...(word.rootEtymologyVersion ? { version: word.rootEtymologyVersion } : {}),
    }
  })
  const counts = {
    all: withStatus.length,
    unchecked: withStatus.filter((item) => item.status === 'unchecked').length,
    checked: withStatus.filter((item) => item.status === 'checked').length,
  }
  const status = input.status ?? 'unchecked'
  const filtered = status === 'all' ? withStatus : withStatus.filter((item) => item.status === status)
  return { total: filtered.length, words: filtered.slice(offset, offset + limit), counts, limit, offset }
}
