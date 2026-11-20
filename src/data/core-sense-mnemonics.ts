/**
 * 0.3.76（task-227）：本义助记单独导出/导入（Word.senseMnemonics + Word.coreSenseOverview）。
 * 候选导出包含没有助记的本义（mnemonic 缺省），供外部批量生成后回导。
 */
import { z } from 'zod'
import { localDateKey, normalizeHeadword, type CoreSenseOverview, type SenseMnemonic } from '../core'
import { getDb } from './db'
import { getEffectiveContent, getEffectiveCoreSensesBatch } from './packs.repo'
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

/** 导入（默认 merge；overwrite=true 才覆盖已有；空文本跳过；stale 只在 issues 报告） */
// ============ 0.3.77（task-230）：批量/两段式导入 ============

export interface CoreSenseMnemonicImportProgress {
  phase: 'resolve' | 'apply'
  done: number
  total: number
}

export interface CoreSenseMnemonicResolvedSense {
  wordId: string
  coreSenseIndex: number
  label: string
  text: string
  source: 'ai' | 'manual'
  updatedAt: number
}

export interface CoreSenseMnemonicResolvedOverview {
  wordId: string
  text: string
  source: 'ai' | 'manual'
  updatedAt: number
}

export interface CoreSenseMnemonicParsedData {
  file: CoreSenseMnemonicExportFile
  senses: CoreSenseMnemonicResolvedSense[]
  overviews: CoreSenseMnemonicResolvedOverview[]
}

export interface CoreSenseMnemonicPreviewReport extends CoreSenseMnemonicImportReport {
  /** 供 applyParsed 复用；不入 UI 展示 */
  parsed?: CoreSenseMnemonicParsedData
}

export interface CoreSenseMnemonicImportOptions {
  overwrite?: boolean
  now?: number
  onProgress?: (progress: CoreSenseMnemonicImportProgress) => void
}

function emptyImportReport(): CoreSenseMnemonicImportReport {
  return { ok: true, counts: emptyCounts(), issues: [] }
}

async function loadWordsByIds(wordIds: string[]): Promise<Map<string, import('../core').Word>> {
  const db = getDb()
  const map = new Map<string, import('../core').Word>()
  for (let i = 0; i < wordIds.length; i += 500) {
    const rows = await db.words.bulkGet(wordIds.slice(i, i + 500))
    for (const row of rows) if (row) map.set(row.id, row)
  }
  return map
}

async function loadWordsByHeadwords(
  headwords: string[],
): Promise<Map<string, import('../core').Word[]>> {
  const db = getDb()
  const map = new Map<string, import('../core').Word[]>()
  const unique = [...new Set(headwords.map((headword) => normalizeHeadword(headword)))]
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500)
    const rows = await db.words.where('headwordLower').anyOf(chunk).toArray()
    for (const word of rows) {
      const list = map.get(word.headwordLower) ?? []
      list.push(word)
      map.set(word.headwordLower, list)
    }
  }
  return map
}

/** 0.3.77：只读预览；批量 resolve + 批量 effective，产出 apply plan（不写库） */
export async function previewCoreSenseMnemonicImport(
  input: string,
  opts: { onProgress?: (progress: CoreSenseMnemonicImportProgress) => void } = {},
): Promise<CoreSenseMnemonicPreviewReport> {
  const report = emptyImportReport()
  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(input)
  } catch {
    return { ...report, ok: false, issues: [{ level: 'error', code: 'E_FORMAT', message: '不是合法 JSON' }] }
  }
  const parsedResult = fileSchema.safeParse(parsedRaw)
  if (!parsedResult.success) {
    return {
      ...report,
      ok: false,
      issues: [{ level: 'error', code: 'E_FORMAT', message: '不是有效的本义助记文件（format/version/结构不匹配）' }],
    }
  }
  const file = parsedResult.data
  const allRows = [
    ...file.words.map((row) => ({ kind: 'overview' as const, row })),
    ...file.senses.map((row) => ({ kind: 'sense' as const, row })),
  ]
  const uniqueWordIds = [...new Set(allRows.map((entry) => entry.row.wordId))]
  report.counts.words = uniqueWordIds.length
  const byId = await loadWordsByIds(uniqueWordIds)
  const missingHeadwords = allRows
    .filter((entry) => !byId.has(entry.row.wordId))
    .map((entry) => entry.row.headword)
  const byHead: Map<string, import('../core').Word[]> =
    missingHeadwords.length > 0 ? await loadWordsByHeadwords(missingHeadwords) : new Map()
  const resolve = (wordId: string, headword: string, deckId?: string) => {
    const direct = byId.get(wordId)
    if (direct) return direct
    const list = byHead.get(normalizeHeadword(headword)) ?? []
    return list.find((word) => (deckId ? word.deckId === deckId : true)) ?? list[0] ?? null
  }
  const matchedIds = new Set<string>()
  const plans: CoreSenseMnemonicParsedData = { file: file as CoreSenseMnemonicExportFile, senses: [], overviews: [] }
  // 批量 effective：先解析出所有命中 word
  for (const entry of allRows) {
    const deckId = entry.kind === 'overview' ? entry.row.deckId : undefined
    const word = resolve(entry.row.wordId, entry.row.headword, deckId)
    if (word) matchedIds.add(word.id)
  }
  const effectiveMap = await getEffectiveCoreSensesBatch([...matchedIds])
  report.counts.wordsMatched = matchedIds.size
  const now = Date.now()
  const seenWordIdsForEffective = new Set<string>()
  let processed = 0
  for (const entry of allRows) {
    processed += 1
    if (processed % 500 === 0) opts.onProgress?.({ phase: 'resolve', done: processed, total: allRows.length })
    const deckId = entry.kind === 'overview' ? entry.row.deckId : undefined
    const word = resolve(entry.row.wordId, entry.row.headword, deckId)
    if (!word) {
      report.counts.unresolvedWords += 1
      report.issues.push({
        level: 'warning',
        code: 'W_UNRESOLVED_WORD',
        message: `找不到词：${entry.row.headword}`,
        wordId: entry.row.wordId,
        headword: entry.row.headword,
      })
      continue
    }
    if (entry.kind === 'overview') {
      const text = String(entry.row.overview?.text ?? '').trim()
      if (!text) {
        report.counts.emptySkipped += 1
        continue
      }
      const existing = word.coreSenseOverview
      if (existing?.text) {
        report.counts.skippedExisting += 1
        if (existing.source === 'manual') report.counts.skippedManual += 1
      } else {
        report.counts.overviewsImported += 1
      }
      plans.overviews.push({
        wordId: word.id,
        text,
        source: entry.row.overview?.source === 'manual' ? 'manual' : 'ai',
        updatedAt: now,
      })
      continue
    }
    if (!seenWordIdsForEffective.has(word.id)) seenWordIdsForEffective.add(word.id)
    const coreSenses = effectiveMap.get(word.id) ?? []
    const label = String(entry.row.label ?? '').trim()
    const current =
      coreSenses.find((sense) => sense.label === label) ??
      coreSenses.find((sense) => sense.index === entry.row.coreSenseIndex)
    if (!current) {
      report.counts.stale += 1
      report.issues.push({
        level: 'warning',
        code: 'W_STALE',
        message: `本义已变化，跳过：${entry.row.headword} · ${label || `#${entry.row.coreSenseIndex}`}`,
        wordId: word.id,
        headword: entry.row.headword,
        coreSenseIndex: entry.row.coreSenseIndex,
      })
      continue
    }
    const text = String(entry.row.mnemonic?.text ?? '').trim()
    if (!text) {
      report.counts.emptySkipped += 1
      continue
    }
    const list = word.senseMnemonics ?? []
    const existing =
      list.find((item) => item.label.trim() === current.label.trim()) ??
      list.find((item) => item.coreSenseIndex === current.index)
    if (existing) {
      report.counts.skippedExisting += 1
      if (existing.source === 'manual') report.counts.skippedManual += 1
    } else {
      report.counts.sensesImported += 1
    }
    plans.senses.push({
      wordId: word.id,
      coreSenseIndex: current.index,
      label: current.label,
      text,
      source: entry.row.mnemonic?.source === 'manual' ? 'manual' : 'ai',
      updatedAt: now,
    })
  }
  opts.onProgress?.({ phase: 'resolve', done: allRows.length, total: allRows.length })
  return { ...report, ok: true, parsed: plans }
}

/** 0.3.77：复用 preview plan 写库；不再 parse/resolve/effective */
export async function applyCoreSenseMnemonicImportParsed(
  preview: CoreSenseMnemonicPreviewReport,
  opts: CoreSenseMnemonicImportOptions = {},
): Promise<CoreSenseMnemonicImportReport> {
  if (!preview.ok || !preview.parsed) {
    return { ok: false, counts: preview.counts, issues: preview.issues }
  }
  const plans = preview.parsed
  const wordIds = [...new Set([...plans.overviews.map((entry) => entry.wordId), ...plans.senses.map((entry) => entry.wordId)])]
  const words = await loadWordsByIds(wordIds)
  const overwrite = opts.overwrite === true
  const now = opts.now ?? Date.now()
  const counts = {
    ...preview.counts,
    sensesImported: 0,
    overviewsImported: 0,
    skippedExisting: 0,
    skippedManual: 0,
  }
  const dirty = new Map<string, import('../core').Word>()
  const flush = async (force = false) => {
    if (!force && dirty.size < 100) return
    if (dirty.size === 0) return
    await getDb().words.bulkPut([...dirty.values()])
    dirty.clear()
  }
  for (const entry of plans.overviews) {
    const word = words.get(entry.wordId)
    if (!word) continue
    if (word.coreSenseOverview?.text && !overwrite) {
      counts.skippedExisting += 1
      if (word.coreSenseOverview.source === 'manual') counts.skippedManual += 1
      continue
    }
    word.coreSenseOverview = { text: entry.text, source: entry.source, updatedAt: entry.updatedAt || now }
    dirty.set(word.id, word)
    counts.overviewsImported += 1
    await flush()
  }
  for (const entry of plans.senses) {
    const word = words.get(entry.wordId)
    if (!word) continue
    const list = [...(word.senseMnemonics ?? [])]
    const foundIndex = list.findIndex((item) => item.label.trim() === entry.label.trim())
    const fallback = foundIndex >= 0 ? foundIndex : list.findIndex((item) => item.coreSenseIndex === entry.coreSenseIndex)
    const existing = fallback >= 0 ? list[fallback] : undefined
    if (existing && !overwrite) {
      counts.skippedExisting += 1
      if (existing.source === 'manual') counts.skippedManual += 1
      continue
    }
    const next: SenseMnemonic = {
      coreSenseIndex: entry.coreSenseIndex,
      label: entry.label,
      text: entry.text,
      source: entry.source,
      updatedAt: entry.updatedAt || now,
    }
    if (fallback >= 0) list[fallback] = next
    else list.push(next)
    word.senseMnemonics = list
    dirty.set(word.id, word)
    counts.sensesImported += 1
    await flush()
  }
  await flush(true)
  const total = wordIds.length
  opts.onProgress?.({ phase: 'apply', done: total, total })
  return { ok: true, counts, issues: preview.issues }
}

/** 便捷入口：字符串会先 preview；也可直接传 preview 结果复用 */
export async function applyCoreSenseMnemonicImport(
  input: string | CoreSenseMnemonicPreviewReport,
  opts: CoreSenseMnemonicImportOptions = {},
): Promise<CoreSenseMnemonicImportReport> {
  const preview = typeof input === 'string' ? await previewCoreSenseMnemonicImport(input, opts) : input
  return applyCoreSenseMnemonicImportParsed(preview, opts)
}

/** 兼容别名 */
export async function importCoreSenseMnemonicJson(
  input: string,
  opts: CoreSenseMnemonicImportOptions = {},
): Promise<CoreSenseMnemonicImportReport> {
  return applyCoreSenseMnemonicImport(input, opts)
}
