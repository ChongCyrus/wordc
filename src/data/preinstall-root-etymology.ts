/** 0.7.0：rootEtymology 预装 bundle 自动导入（幂等/手改保护/失败重试） */
import { getDb } from './db'
import { saveContentEntitiesChunked } from './content-write-source'
import { wordOverlayOf } from './content-snapshot'
import type { ImportIssue } from '../core'
import type { Word } from '../core/types'
import { ROOT_ETYMOLOGY_VERSION } from './root-etymology'
import {
  validateRootEtymologyBundleInput,
  type RootEtymologyBundle,
} from './root-etymology-bundle'

export const ROOT_ETYMOLOGY_PREINSTALL_META_KEY = 'rootEtymology.preinstall'
export const GENERATED_ROOT_ETYMOLOGY_BUNDLE_PATH = 'generated/root-etymology.bundle.json'

export interface RootEtymologyPreinstallDebug {
  bundleIds: number
  dbFound: number
  rootless: number
  missing: number
  repairedAdded: number
  imported: number
  conflicts: number
  stale: number
  error?: string
}

export interface RootEtymologyPreinstallMeta {
  state: 'running' | 'completed' | 'failed' | 'skipped'
  version: string
  importedAt?: number
  count: number
  total: number
  stale: number
  error?: string
  debug?: RootEtymologyPreinstallDebug
}

export interface EnsureRootEtymologyPreinstallOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  force?: boolean
  /** 测试注入 bundle 文本（优先于 fetch） */
  bundleText?: string
  /** 0.7.0：分块写入大小（默认 200，1–1000） */
  chunkSize?: number
  /** 0.7.1：仅原生 APK 执行（Web/PWA 跳过资产 fetch） */
  nativeOnly?: boolean
  /** 0.7.2：发现词表缺词时强制重种内置词库后重试（默认 true） */
  repairMissingDecks?: boolean
  /** 测试注入重种实现（默认 ensureBuiltinDecks force） */
  repairDecks?: () => Promise<unknown>
  /** 进度：解析/写入 */
  onProgress?: (progress: { phase: 'parse' | 'write' | 'done'; done: number; total: number }) => void
}

export interface RootEtymologyPreinstallResult {
  ok: boolean
  skippedVersion: boolean
  skippedNonNative?: boolean
  imported: number
  total: number
  stale: number
  version: string
  issues: ImportIssue[]
  meta?: RootEtymologyPreinstallMeta
}

function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl) return baseUrl
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
    if (env?.BASE_URL) return env.BASE_URL
  } catch {
    /* ignore */
  }
  return '/'
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`
}

export async function getRootEtymologyPreinstallStatus(): Promise<RootEtymologyPreinstallMeta | null> {
  const row = await getDb().meta.get(ROOT_ETYMOLOGY_PREINSTALL_META_KEY)
  return (row?.value as RootEtymologyPreinstallMeta | undefined) ?? null
}

async function writeMeta(meta: RootEtymologyPreinstallMeta): Promise<void> {
  await getDb().meta.put({ key: ROOT_ETYMOLOGY_PREINSTALL_META_KEY, value: meta, updatedAt: Date.now() })
}

let inFlightRootPreinstall: Promise<RootEtymologyPreinstallResult> | null = null

/** 并发去重：AppShell/MePage 同时调用只跑一次，避免第二次把 meta count 覆盖成 0 */
export function ensureRootEtymologyPreinstall(
  opts: EnsureRootEtymologyPreinstallOptions = {},
): Promise<RootEtymologyPreinstallResult> {
  if (opts.force || !inFlightRootPreinstall) {
    const task = runEnsureRootEtymologyPreinstall(opts)
    if (!opts.force) {
      const tracked = task.finally(() => {
        if (inFlightRootPreinstall === tracked) inFlightRootPreinstall = null
      })
      inFlightRootPreinstall = tracked
      return tracked
    }
    return task
  }
  return inFlightRootPreinstall
}

/** 导入预装词根词源：只写无 rootEtymology 的词；手改优先；版本相同跳过 */
async function runEnsureRootEtymologyPreinstall(
  opts: EnsureRootEtymologyPreinstallOptions = {},
): Promise<RootEtymologyPreinstallResult> {
  const issues: ImportIssue[] = []
  const db = getDb()
  if (opts.nativeOnly) {
    try {
      const bridge = (globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge
      if (bridge?.isNativeApp?.() !== 'momo-apk') {
        return { ok: true, skippedVersion: false, skippedNonNative: true, imported: 0, total: 0, stale: 0, version: ROOT_ETYMOLOGY_VERSION, issues }
      }
    } catch {
      return { ok: true, skippedVersion: false, skippedNonNative: true, imported: 0, total: 0, stale: 0, version: ROOT_ETYMOLOGY_VERSION, issues }
    }
  }
  let text = opts.bundleText
  if (text == null) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis)
    if (!fetchImpl) {
      return { ok: false, skippedVersion: false, imported: 0, total: 0, stale: 0, version: ROOT_ETYMOLOGY_VERSION, issues: [{ level: 'warning', code: 'E_IO', message: '无 fetch 环境，无法读取预装词根词源' }] }
    }
    try {
      const response = await fetchImpl(joinUrl(resolveBaseUrl(opts.baseUrl), GENERATED_ROOT_ETYMOLOGY_BUNDLE_PATH))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      text = await response.text()
    } catch (error) {
      const message = `预装词根词源加载失败：${error instanceof Error ? error.message : String(error)}（下次启动重试）`
      await writeMeta({ state: 'failed', version: ROOT_ETYMOLOGY_VERSION, count: 0, total: 0, stale: 0, error: message })
      return { ok: false, skippedVersion: false, imported: 0, total: 0, stale: 0, version: ROOT_ETYMOLOGY_VERSION, issues: [{ level: 'warning', code: 'E_IO', message }] }
    }
  }
  opts.onProgress?.({ phase: 'parse', done: 0, total: 0 })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = `预装词根词源 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
    await writeMeta({ state: 'failed', version: ROOT_ETYMOLOGY_VERSION, count: 0, total: 0, stale: 0, error: message })
    return { ok: false, skippedVersion: false, imported: 0, total: 0, stale: 0, version: ROOT_ETYMOLOGY_VERSION, issues: [{ level: 'warning', code: 'E_FORMAT', message }] }
  }
  const checked = validateRootEtymologyBundleInput(parsed)
  if (!checked.ok || !checked.bundle) {
    const message = checked.issues.find((issue) => issue.level === 'error')?.message ?? '预装词根词源 bundle 格式错误'
    await writeMeta({ state: 'failed', version: ROOT_ETYMOLOGY_VERSION, count: 0, total: checked.stats.items, stale: checked.stats.stale, error: message })
    return { ok: false, skippedVersion: false, imported: 0, total: checked.stats.items, stale: checked.stats.stale, version: ROOT_ETYMOLOGY_VERSION, issues: [{ level: 'warning', code: 'E_FORMAT', message }] }
  }
  const bundle = checked.bundle as RootEtymologyBundle
  const version = bundle.version || ROOT_ETYMOLOGY_VERSION
  // 0.10.0：已完成且计数齐全 → 先按 meta 快速 skip，避免每次启动 bulkGet 5528
  if (!opts.force) {
    const quick = await getRootEtymologyPreinstallStatus()
    if (
      quick?.state === 'completed' &&
      quick.version === version &&
      quick.total > 0 &&
      quick.count >= quick.total
    ) {
      return { ok: true, skippedVersion: true, imported: 0, total: quick.total, stale: quick.stale, version, issues, meta: quick }
    }
  }
  // 0.7.2：旧版词表 6668/升级不重种会导致 34 个专有名词行缺失。
  // 先检测 bundle wordId 是否在 DB；缺词则 force 重种内置词库后重试（仅写缺失/无 root 词）。
  let repaired = false
  const bundleWordIds = [...new Set(bundle.items.map((item) => item.wordId))].filter(Boolean)
  const ids = bundleWordIds
  const initialRows = await db.words.bulkGet(ids)
  let rootlessCount = ids.filter((_id, index) => !initialRows[index] || !initialRows[index]!.rootEtymology).length
  let repairedAdded = 0
  if (opts.repairMissingDecks !== false) {
    const rows = initialRows
    const missing = ids.filter((_id, index) => !rows[index])
    if (missing.length > 0) {
      try {
        if (opts.repairDecks) await opts.repairDecks()
        else {
          const { ensureBuiltinDeckWords } = await import('./builtin')
          const decks = [...new Set(bundle.items.map((item) => item.deckId).filter(Boolean))]
          for (const deckId of decks) {
            const added = await ensureBuiltinDeckWords(deckId)
            repairedAdded += added.added
          }
        }
        repaired = true
      } catch (error) {
        issues.push({ level: 'warning', code: 'E_IO', message: `词表缺词重种失败：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    if (repaired) {
      const refreshed = await db.words.bulkGet(ids)
      rootlessCount = ids.filter((_id, index) => !refreshed[index] || !refreshed[index]!.rootEtymology).length
    }
  }
  if (!opts.force && !repaired && rootlessCount === 0) {
    const existing = await getRootEtymologyPreinstallStatus()
    // 0.7.4：skip 必须同时满足「无缺 root 词」+ meta 完整；count0 的旧 meta 会重算
    const metaComplete = existing?.state === 'completed' && existing.version === version && existing.count > 0
    if (metaComplete) {
      return { ok: true, skippedVersion: true, imported: 0, total: existing!.total, stale: existing!.stale, version, issues, meta: existing }
    }
  }
  const chunkSize = Math.max(1, Math.min(1000, Math.floor(opts.chunkSize ?? 200)))
  await writeMeta({ state: 'running', version, count: 0, total: bundle.items.length, stale: checked.stats.stale })
  let imported = 0
  let stale = checked.stats.stale
  const conflicts: string[] = []
  /** 0.14：sqlite 写入失败后停止（fail-closed），标记 meta failed 以便下次重试 */
  let writeFailure: string | null = null
  const yieldControl = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  for (let offset = 0; offset < bundle.items.length; offset += chunkSize) {
    const chunk = bundle.items.slice(offset, offset + chunkSize)
    const wordIds = chunk.map((item) => item.wordId).filter(Boolean)
    const rows = await db.words.bulkGet(wordIds)
    const rowById = new Map(rows.filter((word): word is Word => Boolean(word)).map((word) => [word.id, word]))
    const updates: Word[] = []
    for (const item of chunk) {
      const word = rowById.get(item.wordId)
      if (!word) {
        stale += 1
        continue
      }
      if (word.rootEtymology) {
        conflicts.push(item.wordId)
        continue
      }
      const incoming = item.rootEtymology
      if (!incoming) {
        stale += 1
        continue
      }
      updates.push({
        ...word,
        rootEtymology: {
          ...incoming,
          parts: incoming.parts,
          source: incoming.source === 'manual' ? 'manual' : 'ai',
          updatedAt: incoming.updatedAt ?? Date.now(),
        },
        ...(item.rootEtymologyCheckedAt != null ? { rootEtymologyCheckedAt: item.rootEtymologyCheckedAt } : {}),
        ...(item.rootEtymologyVersion ? { rootEtymologyVersion: item.rootEtymologyVersion } : {}),
      })
    }
    if (updates.length > 0) {
      // 0.14：统一内容写入口（sqlite 成功后才更新 IDB cache；失败不回写，停止后续分块）
      const overlayRows = updates.map((word) => ({
        key: `word-overlay:${word.id}`,
        kind: 'word-overlay' as const,
        json: JSON.stringify(wordOverlayOf(word as unknown as Record<string, unknown>)),
        updatedAt: (word.rootEtymology as { updatedAt?: number } | undefined)?.updatedAt ?? Date.now(),
      }))
      try {
        const saved = await saveContentEntitiesChunked(overlayRows)
        if (!saved.ok) {
          writeFailure = saved.error ?? '预装词根词源写入失败'
          stale += updates.length
          issues.push({ level: 'warning', code: 'E_IO', message: `词根词源分块写入失败（${offset}–${offset + chunk.length}）：${writeFailure}` })
          break
        }
        imported += updates.length
      } catch (error) {
        stale += updates.length
        issues.push({ level: 'warning', code: 'E_IO', message: `词根词源分块写入失败（${offset}–${offset + chunk.length}）：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    opts.onProgress?.({ phase: 'write', done: Math.min(bundle.items.length, offset + chunk.length), total: bundle.items.length })
    await yieldControl()
  }
  if (writeFailure) {
    const message = `预装词根词源写入失败：${writeFailure}（下次启动重试）`
    await writeMeta({ state: 'failed', version, count: imported, total: bundle.items.length, stale, error: message })
    opts.onProgress?.({ phase: 'done', done: bundle.items.length, total: bundle.items.length })
    issues.push({ level: 'warning', code: 'E_IO', message })
    return { ok: false, skippedVersion: false, imported, total: bundle.items.length, stale, version, issues }
  }
  if (imported === 0 && bundle.items.length > 0 && conflicts.length === 0 && stale > 0) {
    const message = '预装词根词源没有任何可写词（可能词库未就绪）'
    await writeMeta({ state: 'failed', version, count: 0, total: bundle.items.length, stale, error: message })
    return { ok: false, skippedVersion: false, imported: 0, total: bundle.items.length, stale, version, issues: [{ level: 'warning', code: 'E_FIELD', message }] }
  }
  const previous = await getRootEtymologyPreinstallStatus()
  const finalRows = await db.words.bulkGet(bundleWordIds)
  const finalRootless = finalRows.filter((word) => !word?.rootEtymology).length
  const debug: RootEtymologyPreinstallDebug = {
    bundleIds: bundle.items.length,
    dbFound: finalRows.filter(Boolean).length,
    rootless: finalRootless,
    missing: bundleWordIds.length - finalRows.filter(Boolean).length,
    repairedAdded,
    imported,
    conflicts: conflicts.length,
    stale,
    ...(issues.length > 0 ? { error: issues.map((issue) => issue.message).join(' | ').slice(0, 300) } : {}),
  }
  // 0.7.4：count = 本次导入 + 已有 root（含手改/上次预装），不能归一成 0
  let currentCount = imported + conflicts.length
  if (currentCount === 0 && rootlessCount === 0) currentCount = bundle.items.length
  currentCount = Math.min(bundle.items.length, currentCount)
  const keepCount = Math.max(previous?.count ?? 0, currentCount, imported)
  const repairedStillRootless = repaired && finalRootless > 0
  const state: RootEtymologyPreinstallMeta['state'] = repairedStillRootless ? 'failed' : 'completed'
  const meta: RootEtymologyPreinstallMeta = {
    state,
    version,
    importedAt: previous?.importedAt ?? Date.now(),
    count: keepCount,
    total: bundle.items.length,
    stale: Math.min(previous?.stale ?? stale, stale),
    ...(repairedStillRootless
      ? { error: `缺词修复后仍有 ${finalRootless} 个词无词源` }
      : conflicts.length > 0
        ? { error: `${conflicts.length} 个词已有词源，已保留` }
        : {}),
    debug,
  }
  await writeMeta(meta)
  opts.onProgress?.({ phase: 'done', done: bundle.items.length, total: bundle.items.length })
  if (repairedStillRootless) {
    issues.push({ level: 'warning', code: 'E_FIELD', message: meta.error! })
    return { ok: false, skippedVersion: false, imported, total: bundle.items.length, stale, version, issues, meta }
  }
  return { ok: true, skippedVersion: false, imported, total: bundle.items.length, stale, version, issues, meta }
}
