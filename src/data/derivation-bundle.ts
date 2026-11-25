/**
 * task-169（0.3.49）· 整库引申图 JSON 批量导出/导入（wordc-derivation-bundle v1）。
 *
 * schema：
 * {format:'wordc-derivation-bundle', formatVersion:1, exportedAt, items:[{wordId?, headword, deckId?, rootLabel, text?, mermaid?, lines?, source?}]}
 * - 匹配优先 wordId，其次 headwordLower（同 deck 优先）；
 * - 默认 merge：只覆盖匹配词的 derivationMap，缺失词 skip 报告；replace 也不删词，只替换匹配项；
 * - 不覆盖 ncMeaningIds / 用户笔记/助记；不改学习进度。
 */
import { getDb } from './db'
import { saveContentEntitiesChunked } from './content-write-source'
import { wordOverlayOf } from './content-snapshot'
import type { DerivationMap, Word } from '../core/types'
import type { DerivationJsonLine } from './derivation-json'

export const DERIVATION_BUNDLE_FORMAT = 'wordc-derivation-bundle' as const
export const DERIVATION_BUNDLE_VERSION = 1 as const
/** 5MB 上限（防止误导入超大文件） */
export const DERIVATION_BUNDLE_MAX_BYTES = 5 * 1024 * 1024

export interface DerivationBundleItem {
  /** 优先用 wordId 匹配（跨 deck 也按 id 精确） */
  wordId?: string
  headword: string
  deckId?: string
  rootLabel: string
  text?: string
  mermaid?: string
  lines?: DerivationJsonLine[]
  /** 来源保留（可选；AI 导出带 ai） */
  source?: 'manual' | 'ai'
}

export interface DerivationBundle {
  format: typeof DERIVATION_BUNDLE_FORMAT
  formatVersion: typeof DERIVATION_BUNDLE_VERSION
  exportedAt: number
  items: DerivationBundleItem[]
}

export type DerivationBundleParseResult =
  | { ok: true; value: DerivationBundle }
  | { ok: false; errors: string[] }

function lineFromMap(line: DerivationJsonLine): DerivationJsonLine {
  return { text: line.text.trim(), meaningIndexes: [...line.meaningIndexes] }
}

/** 构造整库 bundle（所有带 derivationMap 的词；不含 nc/user 内容） */
export async function exportAllDerivationMaps(): Promise<DerivationBundle> {
  const db = getDb()
  const words = await db.words.toArray()
  const items: DerivationBundleItem[] = []
  for (const word of words) {
    const map = word.derivationMap
    if (!map) continue
    if (!map.rootLabel && !map.text && !map.mermaid && !(map.lines?.length ?? 0)) continue
    items.push({
      wordId: word.id,
      headword: word.headword,
      deckId: word.deckId,
      ...(map.rootLabel ? { rootLabel: map.rootLabel } : { rootLabel: '' }),
      ...(map.text ? { text: map.text } : {}),
      ...(map.mermaid ? { mermaid: map.mermaid } : {}),
      ...(map.lines && map.lines.length > 0 ? { lines: map.lines.map(lineFromMap) } : {}),
      ...(map.source ? { source: map.source } : {}),
    })
  }
  return {
    format: DERIVATION_BUNDLE_FORMAT,
    formatVersion: DERIVATION_BUNDLE_VERSION,
    exportedAt: Date.now(),
    items,
  }
}

/** 解析/校验 bundle JSON（字符串或对象）；含 5MB 上限 */
export interface ParseDerivationBundleOptions {
  /** 覆盖大小上限（默认 5MB；私版预装数据内部导入可放宽） */
  maxBytes?: number
}

export function parseDerivationBundle(
  input: string | unknown,
  opts: ParseDerivationBundleOptions = {},
): DerivationBundleParseResult {
  const maxBytes = opts.maxBytes ?? DERIVATION_BUNDLE_MAX_BYTES
  if (typeof input === 'string' && input.length > maxBytes) {
    return { ok: false, errors: [`文件过大（>${maxBytes / 1024 / 1024}MB）`] }
  }
  let raw: unknown
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch (error) {
      return { ok: false, errors: [`JSON 解析失败：${(error as Error).message}`] }
    }
  } else {
    raw = input
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['不是 JSON 对象'] }
  const obj = raw as Record<string, unknown>
  const errors: string[] = []
  if (obj.format !== DERIVATION_BUNDLE_FORMAT) errors.push(`format 应为 ${DERIVATION_BUNDLE_FORMAT}`)
  if (obj.formatVersion !== DERIVATION_BUNDLE_VERSION) {
    errors.push(`formatVersion 应为 ${DERIVATION_BUNDLE_VERSION}（当前 ${String(obj.formatVersion)}）`)
  }
  const rawItems = obj.items
  if (!Array.isArray(rawItems)) {
    errors.push('items 必须是数组')
    return { ok: false, errors }
  }
  const items: DerivationBundleItem[] = []
  rawItems.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`items[${index}] 不是对象`)
      return
    }
    const entry = item as Record<string, unknown>
    const headword = typeof entry.headword === 'string' ? entry.headword.trim() : ''
    if (!headword) errors.push(`items[${index}].headword 不能为空`)
    const rootLabel = typeof entry.rootLabel === 'string' ? entry.rootLabel.trim() : ''
    const text = typeof entry.text === 'string' ? entry.text.trim() : undefined
    const mermaid = typeof entry.mermaid === 'string' ? entry.mermaid.trim() : undefined
    let lines: DerivationJsonLine[] | undefined
    if (entry.lines !== undefined) {
      if (!Array.isArray(entry.lines)) errors.push(`items[${index}].lines 必须是数组`)
      else {
        const collected: DerivationJsonLine[] = []
        entry.lines.forEach((line, lineIndex) => {
          if (!line || typeof line !== 'object') {
            errors.push(`items[${index}].lines[${lineIndex}] 不是对象`)
            return
          }
          const row = line as Record<string, unknown>
          const lineText = typeof row.text === 'string' ? row.text.trim() : ''
          const indexes = Array.isArray(row.meaningIndexes) ? row.meaningIndexes : null
          if (!lineText) errors.push(`items[${index}].lines[${lineIndex}].text 不能为空`)
          if (!indexes || indexes.length === 0) errors.push(`items[${index}].lines[${lineIndex}].meaningIndexes 必须是非空数组`)
          const valid = (indexes ?? []).filter(
            (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1,
          )
          if (indexes && valid.length !== indexes.length) {
            errors.push(`items[${index}].lines[${lineIndex}].meaningIndexes 只能是 ≥1 的整数`)
          }
          if (lineText && valid.length > 0) {
            collected.push({ text: lineText, meaningIndexes: [...new Set(valid)].sort((a, b) => a - b) })
          }
        })
        if (collected.length > 0) lines = collected
      }
    }
    if (!rootLabel && !text && !mermaid && !(lines && lines.length > 0)) {
      errors.push(`items[${index}] 没有任何引申图内容`)
    }
    const source = entry.source === 'ai' ? 'ai' : entry.source === 'manual' ? 'manual' : undefined
    const wordId = typeof entry.wordId === 'string' && entry.wordId.trim() ? entry.wordId.trim() : undefined
    const itemDeckId = typeof entry.deckId === 'string' && entry.deckId.trim() ? entry.deckId.trim() : undefined
    if (headword) {
      items.push({
        ...(wordId ? { wordId } : {}),
        headword,
        ...(itemDeckId ? { deckId: itemDeckId } : {}),
        rootLabel,
        ...(text ? { text } : {}),
        ...(mermaid ? { mermaid } : {}),
        ...(lines ? { lines } : {}),
        ...(source ? { source } : {}),
      })
    }
  })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      format: DERIVATION_BUNDLE_FORMAT,
      formatVersion: DERIVATION_BUNDLE_VERSION,
      exportedAt: Number.isFinite(obj.exportedAt) ? Number(obj.exportedAt) : Date.now(),
      items,
    },
  }
}

export interface DerivationBundleImportResult {
  imported: number
  skipped: number
  failed: number
  errors: string[]
  skippedItems: Array<{ headword: string; wordId?: string; reason: 'unknown-word' | 'invalid' }>
}

async function findWordForBundleItem(item: DerivationBundleItem): Promise<Word | null> {
  const db = getDb()
  if (item.wordId) {
    const byId = await db.words.get(item.wordId)
    if (byId) return byId
  }
  const lower = item.headword.toLowerCase().trim()
  if (!lower) return null
  const rows = await db.words.where('headwordLower').equals(lower).toArray()
  if (rows.length === 0) return null
  // 同 deck 优先；其次任一（按 id 稳定）
  const inDeck = item.deckId ? rows.find((word) => word.deckId === item.deckId) : undefined
  return inDeck ?? rows.sort((a, b) => (a.id < b.id ? -1 : 1))[0]!
}

function mapFromBundleItem(item: DerivationBundleItem): DerivationMap {
  return {
    ...(item.rootLabel ? { rootLabel: item.rootLabel } : {}),
    ...(item.text ? { text: item.text } : {}),
    ...(item.mermaid ? { mermaid: item.mermaid } : {}),
    ...(item.lines && item.lines.length > 0 ? { lines: item.lines.map(lineFromMap) } : {}),
    source: item.source === 'ai' ? 'ai' : 'manual',
    updatedAt: Date.now(),
  }
}

/**
 * 导入整库引申图。默认/merge 与 replace 都**不删词**、只替换匹配项的 derivationMap；
 * 缺失词 skip 并进入 skippedItems 报告；不覆盖 nc/user 内容/学习进度。
 */
export interface ImportDerivationBundleOptions {
  mode?: 'merge' | 'replace'
  /** 覆盖大小上限（默认 5MB） */
  maxBytes?: number
  /** 0.3.92：每 N 条让出主线程（默认 200） */
  chunkSize?: number
  onProgress?: (progress: { done: number; total: number }) => void
}

export async function importDerivationBundle(
  input: string | unknown,
  opts: ImportDerivationBundleOptions = {},
): Promise<DerivationBundleImportResult> {
  void (opts.mode ?? 'merge') // 当前两模式均“只替换匹配项”；保留 API 供未来差异
  const parsed = parseDerivationBundle(input, { ...(opts.maxBytes != null ? { maxBytes: opts.maxBytes } : {}) })
  if (!parsed.ok) return { imported: 0, skipped: 0, failed: 0, errors: parsed.errors, skippedItems: [] }
  let imported = 0
  let skipped = 0
  let failed = 0
  const errors: string[] = []
  const skippedItems: DerivationBundleImportResult['skippedItems'] = []
  const updates = new Map<string, Word>()
  const total = parsed.value.items.length
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? 200))
  let processed = 0
  for (const item of parsed.value.items) {
    processed += 1
    if (processed % chunkSize === 0) {
      opts.onProgress?.({ done: processed, total })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    try {
      const word = await findWordForBundleItem(item)
      if (!word) {
        skipped += 1
        skippedItems.push({
          headword: item.headword,
          ...(item.wordId ? { wordId: item.wordId } : {}),
          reason: 'unknown-word',
        })
        continue
      }
      const next: Word = {
        ...(updates.get(word.id) ?? word),
        derivationMap: mapFromBundleItem(item),
      }
      updates.set(word.id, next)
      imported += 1
    } catch (error) {
      failed += 1
      errors.push(`${item.headword}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (updates.size > 0) {
    // 0.14：统一内容写入口；sqlite 成功后才更新 IDB cache，失败不回写
    const rows = [...updates.values()].map((word) => {
      const overlay = wordOverlayOf(word as unknown as Record<string, unknown>)
      return {
        key: `word-overlay:${word.id}`,
        kind: 'word-overlay' as const,
        json: JSON.stringify(overlay),
        updatedAt: Number((word.derivationMap as { updatedAt?: number } | undefined)?.updatedAt) || Date.now(),
      }
    })
    const saved = await saveContentEntitiesChunked(rows)
    if (!saved.ok) return { imported: 0, skipped, failed: failed + 1, errors: [...errors, saved.error ?? '引申图导入写入失败'], skippedItems }
  }
  return { imported, skipped, failed, errors, skippedItems }
}
