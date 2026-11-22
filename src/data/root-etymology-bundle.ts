/** 0.4.0/task-284 C1：rootEtymology 独立 bundle 导出/导入（版本/checksum/merge/手改保护/预装预留） */
import { computeChecksum, stableStringify } from './checksum'
import { getDb } from './db'
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
  for (const item of bundle.items) {
    try {
      if (!item || typeof item.wordId !== 'string') throw new Error('item 缺少 wordId')
      const word = await db.words.get(item.wordId)
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
      }
      await db.words.put(next)
      report.updated += 1
    } catch (error) {
      report.failed.push({ wordId: String(item?.wordId ?? '?'), reason: error instanceof Error ? error.message : String(error) })
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
