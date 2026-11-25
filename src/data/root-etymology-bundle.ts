/** 0.4.0/task-284 C1：rootEtymology 独立 bundle 导出/导入（版本/checksum/merge/手改保护/预装预留） */
import { computeChecksum, stableStringify } from './checksum'
import { getDb } from './db'
import { ContentWriteError, saveContentEntitiesChunked, saveWordOverlay } from './content-write-source'
import { wordOverlayOf } from './content-snapshot'
import type { RootEtymology, Word } from '../core/types'
import { ROOT_ETYMOLOGY_VERSION, normalizeRootEtymologyParts } from './root-etymology'

export const ROOT_ETYMOLOGY_BUNDLE_FORMAT = 'momo-root-etymology-bundle'
export const ROOT_ETYMOLOGY_BUNDLE_VERSION = 1

export interface RootEtymologyBundleItem {
  wordId: string
  headword: string
  deckId: string
  rootEtymology?: RootEtymology
  rootEtymologyCheckedAt?: number
  rootEtymologyVersion?: string
}

export interface RootEtymologyBundle {
  format: typeof ROOT_ETYMOLOGY_BUNDLE_FORMAT
  formatVersion: typeof ROOT_ETYMOLOGY_BUNDLE_VERSION
  version: string
  createdAt: number
  generator: string
  counts: { items: number }
  items: RootEtymologyBundleItem[]
  checksum?: string
}

export interface RootEtymologyBundleImportReport {
  ok: boolean
  updated: number
  skippedManual: number
  skippedMissing: number
  failed: Array<{ wordId: string; reason: string }>
  issues: Array<{ level: 'info' | 'warning' | 'error'; message: string }>
}

export interface RootEtymologyBundleExportOptions {
  deckId?: string
  wordIds?: readonly string[]
  now?: number
}

function toItem(word: Word): RootEtymologyBundleItem | null {
  if (!word.rootEtymology && word.rootEtymologyCheckedAt == null) return null
  return {
    wordId: word.id,
    headword: word.headword,
    deckId: word.deckId,
    ...(word.rootEtymology ? { rootEtymology: word.rootEtymology } : {}),
    ...(word.rootEtymologyCheckedAt != null ? { rootEtymologyCheckedAt: word.rootEtymologyCheckedAt } : {}),
    ...(word.rootEtymologyVersion ? { rootEtymologyVersion: word.rootEtymologyVersion } : {}),
  }
}

/** 导出 bundle 对象（预装/下载共用） */
export async function buildRootEtymologyBundle(opts: RootEtymologyBundleExportOptions = {}): Promise<RootEtymologyBundle> {
  const db = getDb()
  let words: Word[]
  if (opts.wordIds && opts.wordIds.length > 0) {
    const ids = [...new Set(opts.wordIds)]
    const rows = await db.words.bulkGet(ids)
    words = ids.map((id) => rows.find((row) => row?.id === id)).filter((word): word is Word => Boolean(word))
  } else if (opts.deckId) {
    words = await db.words.where('deckId').equals(opts.deckId).toArray()
  } else {
    words = await db.words.toArray()
  }
  const items = words.map((word) => toItem(word)).filter((item): item is RootEtymologyBundleItem => item != null)
  const payload = {
    format: ROOT_ETYMOLOGY_BUNDLE_FORMAT,
    formatVersion: ROOT_ETYMOLOGY_BUNDLE_VERSION,
    version: ROOT_ETYMOLOGY_VERSION,
    createdAt: opts.now ?? Date.now(),
    generator: 'momo-root-etymology',
    counts: { items: items.length },
    items,
  } satisfies Omit<RootEtymologyBundle, 'checksum'>
  const checksum = await computeChecksum(stableStringify(payload))
  return { ...payload, checksum: checksum.hex }
}

export async function exportRootEtymologyBundleText(opts: RootEtymologyBundleExportOptions = {}): Promise<string> {
  return stableStringify(await buildRootEtymologyBundle(opts))
}

function parseBundle(input: string | RootEtymologyBundle): RootEtymologyBundle {
  const bundle = typeof input === 'string' ? (JSON.parse(input) as RootEtymologyBundle) : input
  if (!bundle || typeof bundle !== 'object') throw new Error('bundle 不是对象')
  if (bundle.format !== ROOT_ETYMOLOGY_BUNDLE_FORMAT) throw new Error('不是词根词源 bundle')
  if (bundle.formatVersion !== ROOT_ETYMOLOGY_BUNDLE_VERSION) throw new Error('bundle 版本不支持')
  if (!Array.isArray(bundle.items)) throw new Error('bundle.items 缺失')
  return bundle
}

/** 导入：按 wordId 匹配；手改优先；AI/空覆盖 AI/空；回报统计。 */
export async function importRootEtymologyBundle(
  input: string | RootEtymologyBundle,
  opts: { preserveManual?: boolean; now?: number; force?: boolean } = {},
): Promise<RootEtymologyBundleImportReport> {
  const report: RootEtymologyBundleImportReport = {
    ok: true,
    updated: 0,
    skippedManual: 0,
    skippedMissing: 0,
    failed: [],
    issues: [],
  }
  const bundle = parseBundle(input)
  const payload = {
    format: bundle.format,
    formatVersion: bundle.formatVersion,
    version: bundle.version,
    createdAt: bundle.createdAt,
    generator: bundle.generator,
    counts: bundle.counts,
    items: bundle.items,
  }
  if (bundle.checksum && !opts.force) {
    const checksum = await computeChecksum(stableStringify(payload))
    if (checksum.hex !== bundle.checksum) {
      report.ok = false
      report.issues.push({ level: 'error', message: 'bundle checksum 校验失败' })
      return report
    }
  }
  const db = getDb()
  const now = opts.now ?? Date.now()
  const preserveManual = opts.preserveManual !== false
  // 0.11.1：批量化读取/写入，避免 6000+ 条逐条 IndexedDB 事务导致 Web 端导入挂起。
  const BATCH = 300
  for (let start = 0; start < bundle.items.length; start += BATCH) {
    const chunk = bundle.items.slice(start, start + BATCH)
    const ids = chunk.map((item) => (item && typeof item.wordId === 'string' ? item.wordId : ''))
    let rows: Array<Word | undefined> = []
    try {
      rows = await db.words.bulkGet(ids)
    } catch {
      rows = []
    }
    const updates: Word[] = []
    /** 0.14：需要清除 rootEtymology 的词（overlay 合并无法表达字段删除，走单条写入口） */
    const clears: Word[] = []
    for (let index = 0; index < chunk.length; index += 1) {
      const item = chunk[index]
      try {
        if (!item || typeof item.wordId !== 'string') throw new Error('item 缺少 wordId')
        const word = rows[index]
        if (!word) {
          report.skippedMissing += 1
          continue
        }
        if (preserveManual && word.rootEtymology?.source === 'manual') {
          report.skippedManual += 1
          continue
        }
        const incoming = item.rootEtymology
        if (incoming) {
          const parts = normalizeRootEtymologyParts(incoming.parts)
          if (parts.length === 0 && !incoming.etymology) {
            report.failed.push({ wordId: item.wordId, reason: 'bundle 条目没有有效 parts/etymology' })
            continue
          }
        }
        const next: Word = {
          ...word,
          ...(incoming
            ? {
                rootEtymology: {
                  ...incoming,
                  parts: normalizeRootEtymologyParts(incoming.parts),
                  ...(incoming.etymology ? { etymology: incoming.etymology } : {}),
                  ...(incoming.composition ? { composition: incoming.composition } : {}),
                  source: incoming.source === 'manual' ? 'manual' : 'ai',
                  updatedAt: incoming.updatedAt ?? now,
                },
              }
            : {}),
          ...(item.rootEtymologyCheckedAt != null ? { rootEtymologyCheckedAt: item.rootEtymologyCheckedAt } : {}),
          ...(item.rootEtymologyVersion ? { rootEtymologyVersion: item.rootEtymologyVersion } : {}),
        }
        if (!incoming) {
          delete next.rootEtymology
          clears.push(next)
        } else {
          updates.push(next)
        }
      } catch (error) {
        report.failed.push({ wordId: String(item?.wordId ?? '?'), reason: error instanceof Error ? error.message : String(error) })
      }
    }
    // 0.14：统一内容写入口。sqlite 成功后才更新 IDB cache；失败停止且不回写 IDB。
    let writeStopped = false
    for (const word of clears) {
      try {
        await saveWordOverlay(word)
        report.updated += 1
      } catch (error) {
        report.failed.push({ wordId: word.id, reason: error instanceof Error ? error.message : String(error) })
        if (error instanceof ContentWriteError) {
          writeStopped = true
          report.issues.push({ level: 'error', message: `词根词源 bundle 写入失败，已停止：${error.message}` })
          break
        }
      }
    }
    if (writeStopped) break
    if (updates.length > 0) {
      const overlayRows = updates.map((word) => ({
        key: `word-overlay:${word.id}`,
        kind: 'word-overlay' as const,
        json: JSON.stringify(wordOverlayOf(word as unknown as Record<string, unknown>)),
        updatedAt: (word.rootEtymology as { updatedAt?: number } | undefined)?.updatedAt ?? now,
      }))
      try {
        const saved = await saveContentEntitiesChunked(overlayRows)
        if (!saved.ok) {
          report.failed.push({ wordId: `batch:${start}`, reason: saved.error ?? '词根词源导入写入失败' })
          report.issues.push({ level: 'error', message: `词根词源 bundle 写入失败，已停止：${saved.error ?? '未知错误'}` })
          break
        }
        report.updated += updates.length
      } catch (error) {
        report.failed.push({ wordId: `batch:${start}`, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  if (report.failed.length > 0) {
    report.ok = false
    report.issues.push({ level: 'warning', message: `${report.failed.length} 条 bundle 条目导入失败` })
  }
  return report
}

/** 预装预留：判断输入是否 rootEtymology bundle */
export function isRootEtymologyBundle(raw: unknown): raw is RootEtymologyBundle {
  return (
    Boolean(raw) &&
    typeof raw === 'object' &&
    (raw as { format?: unknown }).format === ROOT_ETYMOLOGY_BUNDLE_FORMAT &&
    (raw as { formatVersion?: unknown }).formatVersion === ROOT_ETYMOLOGY_BUNDLE_VERSION
  )
}

// ============ 0.7.0：分片合并/校验（500 分片试点/全量） ============

export interface RootEtymologyBundleValidation {
  ok: boolean
  bundle?: RootEtymologyBundle
  issues: Array<{ level: 'warning' | 'error'; message: string; wordId?: string }>
  stats: { items: number; valid: number; invalid: number; duplicate: number; stale: number }
}

/** 校验并规范化 bundle（parts.meaning 必填）；返回可合并 bundle */
export function validateRootEtymologyBundleInput(raw: unknown): RootEtymologyBundleValidation {
  const issues: RootEtymologyBundleValidation['issues'] = []
  const stats = { items: 0, valid: 0, invalid: 0, duplicate: 0, stale: 0 }
  const bundle = raw as RootEtymologyBundle | null
  if (!bundle || typeof bundle !== 'object' || bundle.format !== ROOT_ETYMOLOGY_BUNDLE_FORMAT) {
    return { ok: false, issues: [{ level: 'error', message: '不是 momo-root-etymology-bundle' }], stats }
  }
  if (bundle.formatVersion !== ROOT_ETYMOLOGY_BUNDLE_VERSION) {
    return { ok: false, issues: [{ level: 'error', message: `bundle 版本不支持：${String(bundle.formatVersion)}` }], stats }
  }
  const seen = new Set<string>()
  const items: RootEtymologyBundleItem[] = []
  for (const item of Array.isArray(bundle.items) ? bundle.items : []) {
    stats.items += 1
    if (!item || typeof item.wordId !== 'string' || !item.wordId) {
      stats.invalid += 1
      issues.push({ level: 'warning', message: 'item 缺少 wordId' })
      continue
    }
    if (seen.has(item.wordId)) {
      stats.duplicate += 1
      continue
    }
    seen.add(item.wordId)
    const incoming = item.rootEtymology
    if (incoming) {
      const parts = normalizeRootEtymologyParts(incoming.parts)
      if (parts.length === 0 && !incoming.etymology) {
        stats.invalid += 1
        issues.push({ level: 'warning', message: 'item 没有有效 parts/etymology', wordId: item.wordId })
        continue
      }
      if (parts.length !== (incoming.parts ?? []).length) {
        stats.stale += 1
        issues.push({ level: 'warning', message: '部分 part 缺 meaning/text，已过滤', wordId: item.wordId })
      }
      items.push({ ...item, rootEtymology: { ...incoming, parts } })
      stats.valid += 1
    } else {
      items.push(item)
      stats.valid += 1
    }
  }
  return {
    ok: stats.invalid === 0,
    bundle: {
      format: ROOT_ETYMOLOGY_BUNDLE_FORMAT,
      formatVersion: ROOT_ETYMOLOGY_BUNDLE_VERSION,
      version: bundle.version ?? ROOT_ETYMOLOGY_VERSION,
      createdAt: bundle.createdAt ?? Date.now(),
      generator: bundle.generator ?? 'momo-root-etymology',
      counts: { items: items.length },
      items,
    },
    issues,
    stats,
  }
}

/** 合并多分片（每片最多500词）；按 wordId 去重、校验 meaning、重算 checksum/counts */
export async function mergeRootEtymologyBundles(
  parts: readonly (RootEtymologyBundle | RootEtymologyBundleItem[])[],
): Promise<RootEtymologyBundleValidation> {
  const issues: RootEtymologyBundleValidation['issues'] = []
  const stats = { items: 0, valid: 0, invalid: 0, duplicate: 0, stale: 0 }
  const seen = new Set<string>()
  const merged: RootEtymologyBundleItem[] = []
  for (const part of parts) {
    const raw: RootEtymologyBundle = Array.isArray(part)
      ? {
          format: ROOT_ETYMOLOGY_BUNDLE_FORMAT,
          formatVersion: ROOT_ETYMOLOGY_BUNDLE_VERSION,
          version: ROOT_ETYMOLOGY_VERSION,
          createdAt: Date.now(),
          generator: 'momo-root-etymology',
          counts: { items: part.length },
          items: part,
        }
      : part
    const checked = validateRootEtymologyBundleInput(raw)
    stats.items += checked.stats.items
    stats.invalid += checked.stats.invalid
    stats.duplicate += checked.stats.duplicate
    stats.stale += checked.stats.stale
    issues.push(...checked.issues)
    for (const item of checked.bundle?.items ?? []) {
      if (seen.has(item.wordId)) {
        stats.duplicate += 1
        continue
      }
      seen.add(item.wordId)
      merged.push(item)
      stats.valid += 1
    }
  }
  const payload = {
    format: ROOT_ETYMOLOGY_BUNDLE_FORMAT,
    formatVersion: ROOT_ETYMOLOGY_BUNDLE_VERSION,
    version: ROOT_ETYMOLOGY_VERSION,
    createdAt: Date.now(),
    generator: 'momo-root-etymology',
    counts: { items: merged.length },
    items: merged,
  } satisfies Omit<RootEtymologyBundle, 'checksum'>
  const checksum = await computeChecksum(stableStringify(payload))
  return {
    ok: stats.invalid === 0,
    bundle: { ...payload, checksum: checksum.hex },
    issues,
    stats,
  }
}
