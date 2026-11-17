/**
 * 0.3.76（task-227）：本义助记单独导出/导入（Word.senseMnemonics + Word.coreSenseOverview）。
 * 候选导出包含没有助记的本义（mnemonic 缺省），供外部批量生成后回导。
 */
import { z } from 'zod'
import { localDateKey, normalizeHeadword, type CoreSenseOverview, type SenseMnemonic } from '../core'
import { getDb } from './db'
import { getEffectiveContent } from './packs.repo'
import { stableStringify } from './checksum'

export const CORE_SENSE_MNEMONIC_FORMAT = 'wordc-core-sense-mnemonics'
export const CORE_SENSE_MNEMONIC_VERSION = 1

export interface CoreSenseMnemonicWordExport {
  wordId: string
  deckId: string
  headword: string
  overview?: CoreSenseOverview
}

export interface CoreSenseMnemonicSenseExport {
  wordId: string
  headword: string
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  /** 缺省 = 候选（尚无本义助记） */
  mnemonic?: { text: string; source: 'ai' | 'manual'; updatedAt: number }
}

export interface CoreSenseMnemonicExportFile {
  format: typeof CORE_SENSE_MNEMONIC_FORMAT
  version: typeof CORE_SENSE_MNEMONIC_VERSION
  exportedAt: number
  deckId?: string
  words: CoreSenseMnemonicWordExport[]
  senses: CoreSenseMnemonicSenseExport[]
}

export interface CoreSenseMnemonicImportCounts {
  words: number
  wordsMatched: number
  sensesImported: number
  overviewsImported: number
  skippedExisting: number
  skippedManual: number
  stale: number
  emptySkipped: number
  unresolvedWords: number
}

export interface CoreSenseMnemonicImportIssue {
  level: 'error' | 'warning'
  code: string
  message: string
  wordId?: string
  headword?: string
  coreSenseIndex?: number
}

export interface CoreSenseMnemonicImportReport {
  ok: boolean
  counts: CoreSenseMnemonicImportCounts
  issues: CoreSenseMnemonicImportIssue[]
}

export const coreSenseMnemonicFileName = (now = Date.now()): string =>
  `背单词-本义助记-${localDateKey(now)}.json`

const mnemonicSchema = z.object({
  text: z.string(),
  source: z.enum(['ai', 'manual']).optional(),
  updatedAt: z.number().optional(),
})
const overviewSchema = z.object({
  text: z.string(),
  source: z.enum(['ai', 'manual']).optional(),
  updatedAt: z.number().optional(),
})
const fileSchema = z.object({
  format: z.literal(CORE_SENSE_MNEMONIC_FORMAT),
  version: z.literal(CORE_SENSE_MNEMONIC_VERSION),
  exportedAt: z.number(),
  deckId: z.string().optional(),
  words: z.array(
    z.object({
      wordId: z.string(),
      deckId: z.string(),
      headword: z.string(),
      overview: overviewSchema.optional(),
    }),
  ),
  senses: z.array(
    z.object({
      wordId: z.string(),
      headword: z.string(),
      coreSenseIndex: z.number().int().min(1),
      label: z.string(),
      gloss: z.string().optional(),
      origin: z.string().optional(),
      mnemonic: mnemonicSchema.optional(),
    }),
  ),
})

function emptyCounts(): CoreSenseMnemonicImportCounts {
  return {
    words: 0,
    wordsMatched: 0,
    sensesImported: 0,
    overviewsImported: 0,
    skippedExisting: 0,
    skippedManual: 0,
    stale: 0,
    emptySkipped: 0,
    unresolvedWords: 0,
  }
}

async function* pagedWords(deckId: string | undefined, pageSize: number): AsyncGenerator<import('../core').Word[]> {
  const db = getDb()
  let offset = 0
  for (;;) {
    const rows = deckId
      ? await db.words
          .where('[deckId+order]')
          .between([deckId, -Infinity], [deckId, Infinity])
          .offset(offset)
          .limit(pageSize)
          .toArray()
      : await db.words.offset(offset).limit(pageSize).toArray()
    if (rows.length === 0) return
    yield rows
    if (rows.length < pageSize) return
    offset += rows.length
  }
}

/** 构建 v1 导出对象；分页读词，不一次性取全库 */
export async function buildCoreSenseMnemonicExport(
  opts: { deckId?: string; pageSize?: number; now?: number } = {},
): Promise<CoreSenseMnemonicExportFile> {
  const pageSize = Math.max(1, Math.min(500, Math.floor(opts.pageSize ?? 300)))
  const words: CoreSenseMnemonicWordExport[] = []
  const senses: CoreSenseMnemonicSenseExport[] = []
  for await (const rows of pagedWords(opts.deckId, pageSize)) {
    for (const word of rows) {
      const effective = await getEffectiveContent(word.id)
      const coreSenses = effective?.coreSenses ?? []
      const stored = word.senseMnemonics ?? []
      const overview = word.coreSenseOverview
      if (overview?.text) {
        words.push({ wordId: word.id, deckId: word.deckId, headword: word.headword, overview })
      }
      for (const sense of coreSenses) {
        const mnemonic =
          stored.find((entry) => entry.label.trim() === sense.label.trim()) ??
          stored.find((entry) => entry.coreSenseIndex === sense.index)
        senses.push({
          wordId: word.id,
          headword: word.headword,
          coreSenseIndex: sense.index,
          label: sense.label,
          ...(sense.note ? { gloss: sense.note } : {}),
          ...(sense.origin ? { origin: sense.origin } : {}),
          ...(mnemonic?.text ? { mnemonic: { text: mnemonic.text, source: mnemonic.source, updatedAt: mnemonic.updatedAt } } : {}),
        })
      }
    }
  }
  return {
    format: CORE_SENSE_MNEMONIC_FORMAT,
    version: CORE_SENSE_MNEMONIC_VERSION,
    exportedAt: opts.now ?? Date.now(),
    ...(opts.deckId ? { deckId: opts.deckId } : {}),
    words,
    senses,
  }
}

export async function exportCoreSenseMnemonicJson(opts: { deckId?: string; pageSize?: number } = {}): Promise<Blob> {
  const file = await buildCoreSenseMnemonicExport(opts)
  return new Blob([stableStringify(file)], { type: 'application/json' })
}

async function resolveWord(
  wordId: string,
  headword: string,
  deckId: string | undefined,
): Promise<import('../core').Word | null> {
  const db = getDb()
  const byId = await db.words.get(wordId)
  if (byId) return byId
  const lower = normalizeHeadword(headword)
  const candidates = await db.words.where('headwordLower').equals(lower).toArray()
  return candidates.find((word) => (deckId ? word.deckId === deckId : true)) ?? candidates[0] ?? null
}

/** 导入（默认 merge；overwrite=true 才覆盖已有；空文本跳过；stale 只在 issues 报告） */
async function runCoreSenseMnemonicImport(
  input: string,
  opts: { overwrite?: boolean; now?: number; dryRun?: boolean } = {},
): Promise<CoreSenseMnemonicImportReport> {
  const counts = emptyCounts()
  const issues: CoreSenseMnemonicImportIssue[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return {
      ok: false,
      counts,
      issues: [{ level: 'error', code: 'E_FORMAT', message: '不是合法 JSON' }],
    }
  }
  const result = fileSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      counts,
      issues: [
        {
          level: 'error',
          code: 'E_FORMAT',
          message: '不是有效的本义助记文件（format/version/结构不匹配）',
        },
      ],
    }
  }
  const file = result.data
  const overwrite = opts.overwrite === true
  const now = opts.now ?? Date.now()
  counts.words = new Set([...file.words.map((row) => row.wordId), ...file.senses.map((row) => row.wordId)]).size
  const dirty = new Map<string, import('../core').Word>()
  const effectiveCache = new Map<string, Awaited<ReturnType<typeof getEffectiveContent>>>()
  const markDirty = (word: import('../core').Word) => dirty.set(word.id, word)
  const dirtyWords = dirty
  const flush = async (force = false) => {
    if (opts.dryRun) return
    if (!force && dirtyWords.size < 100) return
    if (dirtyWords.size === 0) return
    await getDb().words.bulkPut([...dirtyWords.values()])
    dirtyWords.clear()
  }

  const resolveForUpdate = async (wordId: string, headword: string, deckId?: string) => {
    const direct = dirty.get(wordId)
    if (direct) return direct
    const resolved = await resolveWord(wordId, headword, deckId)
    if (!resolved) return null
    return dirty.get(resolved.id) ?? resolved
  }

  // overviews
  for (const row of file.words) {
    const word = await resolveForUpdate(row.wordId, row.headword, row.deckId)
    if (!word) {
      counts.unresolvedWords += 1
      issues.push({ level: 'warning', code: 'W_UNRESOLVED_WORD', message: `找不到词：${row.headword}`, wordId: row.wordId, headword: row.headword })
      continue
    }
    counts.wordsMatched += 1
    const text = String(row.overview?.text ?? '').trim()
    if (!text) {
      counts.emptySkipped += 1
      continue
    }
    if (word.coreSenseOverview?.text) {
      counts.skippedExisting += 1
      if (word.coreSenseOverview.source === 'manual') counts.skippedManual += 1
      if (!overwrite) continue
    }
    word.coreSenseOverview = {
      text,
      source: row.overview?.source === 'manual' ? 'manual' : 'ai',
      updatedAt: now,
    }
    counts.overviewsImported += 1
    markDirty(word)
    await flush()
  }

  const matchedWordIds = new Set<string>()
  for (const row of file.senses) {
    const word = await resolveForUpdate(row.wordId, row.headword, undefined)
    if (!word) {
      counts.unresolvedWords += 1
      issues.push({
        level: 'warning',
        code: 'W_UNRESOLVED_WORD',
        message: `找不到词：${row.headword}`,
        wordId: row.wordId,
        headword: row.headword,
      })
      continue
    }
    if (!matchedWordIds.has(word.id)) {
      matchedWordIds.add(word.id)
      counts.wordsMatched += 1
    }
    let effective = effectiveCache.get(word.id)
    if (effective === undefined) {
      effective = await getEffectiveContent(word.id)
      effectiveCache.set(word.id, effective)
    }
    const coreSenses = effective?.coreSenses ?? []
    const label = String(row.label ?? '').trim()
    const current =
      coreSenses.find((sense) => sense.label === label) ??
      coreSenses.find((sense) => sense.index === row.coreSenseIndex)
    if (!current) {
      counts.stale += 1
      issues.push({
        level: 'warning',
        code: 'W_STALE',
        message: `本义已变化，跳过：${row.headword} · ${label || `#${row.coreSenseIndex}`}`,
        wordId: word.id,
        headword: row.headword,
        coreSenseIndex: row.coreSenseIndex,
      })
      continue
    }
    const mnemonicText = String(row.mnemonic?.text ?? '').trim()
    if (!mnemonicText) {
      counts.emptySkipped += 1
      continue
    }
    const list = [...(word.senseMnemonics ?? [])]
    const foundIndex = list.findIndex((entry) => entry.label.trim() === current.label.trim())
    const fallback = foundIndex >= 0 ? foundIndex : list.findIndex((entry) => entry.coreSenseIndex === current.index)
    const existing = fallback >= 0 ? list[fallback] : undefined
    if (existing) {
      counts.skippedExisting += 1
      if (existing.source === 'manual') counts.skippedManual += 1
      if (!overwrite) continue
    }
    const entry: SenseMnemonic = {
      coreSenseIndex: current.index,
      label: current.label,
      text: mnemonicText,
      source: row.mnemonic?.source === 'manual' ? 'manual' : 'ai',
      updatedAt: now,
    }
    if (fallback >= 0) list[fallback] = entry
    else list.push(entry)
    word.senseMnemonics = list
    counts.sensesImported += 1
    markDirty(word)
    await flush()
  }
  await flush(true)
  return { ok: true, counts, issues }
}

/** 0.3.76：只读预览（format/version 校验 + word/sense 匹配 + stale/skip 预估，不写库） */
export async function previewCoreSenseMnemonicImport(input: string): Promise<CoreSenseMnemonicImportReport> {
  return runCoreSenseMnemonicImport(input, { dryRun: true })
}

/** 0.3.76：确认后写库；overwrite=true 才覆盖已有（含 manual） */
export async function applyCoreSenseMnemonicImport(
  input: string,
  opts: { overwrite?: boolean; now?: number } = {},
): Promise<CoreSenseMnemonicImportReport> {
  return runCoreSenseMnemonicImport(input, opts)
}

/** 兼容别名 */
export async function importCoreSenseMnemonicJson(
  input: string,
  opts: { overwrite?: boolean; now?: number } = {},
): Promise<CoreSenseMnemonicImportReport> {
  return applyCoreSenseMnemonicImport(input, opts)
}
