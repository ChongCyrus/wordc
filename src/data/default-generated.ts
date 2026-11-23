/**
 * 0.3.91/task-270：私版首次启动自动导入预生成数据（本义助记 + 引申图 bundle）。
 * - 仅 `VITE_PRIVATE_PACKS=1` 执行；公开版直接跳过；
 * - 幂等：meta `generated.defaultSeeded` 版本标记；失败不写标记，下次启动重试；
 * - merge：本义助记默认不覆盖已有（含 manual）；引申图跳过已有 manual derivationMap；
 * - 不阻塞启动（调用方 fire-and-forget）。
 */
import type { ImportIssue } from '../core'
import { getDb } from './db'
import { ensureDefaultContentPacks } from './default-packs'
import {
  applyCoreSenseMnemonicImportParsed,
  previewCoreSenseMnemonicImport,
  type CoreSenseMnemonicImportReport,
} from './core-sense-mnemonics'
import { importDerivationBundle, type DerivationBundleImportResult } from './derivation-bundle'
import { isPrivatePacksEnabled } from './default-packs'
import { getRootEtymologyPreinstallStatus, type RootEtymologyPreinstallDebug } from './preinstall-root-etymology'

export const DEFAULT_GENERATED_META_KEY = 'generated.defaultSeeded'
export const GENERATED_SEED_STATE_KEY = 'generated.seedState'
export const DEFAULT_GENERATED_VERSION = 1
export const GENERATED_SENSE_MNEMONICS_PATH = 'generated/core-sense-mnemonics.json'
export const GENERATED_DERIVATION_BUNDLE_PATH = 'generated/dagang-derivation-bundle-v1.json'

export interface EnsureDefaultGeneratedOptions {
  /** 测试/强制重导入 */
  force?: boolean
  /** 显式覆盖私版判定（测试用） */
  includePrivate?: boolean
  /** 0.3.92：仅 APK 自动导入；Web/PWA 跳过（测试可传 false） */
  nativeOnly?: boolean
  /** 0.3.92：AppShell 自动模式；老用户（已有 state）直接跳过 */
  autoMode?: boolean
  /** 已有生成内容达到该词数则直接标记已导入（默认100） */
  existingThreshold?: number
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** 测试注入 rootEtymology bundle 文本（不传则真实 APK fetch 资产） */
  rootEtymologyBundleText?: string
  onProgress?: (progress: { phase: 'sense' | 'derivation' | 'rootEtymology'; done: number; total: number }) => void
}

export type GeneratedSeedState = 'idle' | 'running' | 'completed' | 'failed' | 'skipped-existing' | 'skipped-public' | 'skipped-non-native'

export interface GeneratedSeedStatus {
  /** 当前构建/环境是否支持预装（私版 APK） */
  supported: boolean
  state: GeneratedSeedState
  phase?: 'sense' | 'derivation' | 'rootEtymology'
  rootEtymologyImported?: number
  rootEtymologyTotal?: number
  rootEtymologyVersion?: string
  rootEtymologyState?: 'running' | 'completed' | 'failed' | 'skipped'
  rootEtymologyError?: string
  rootEtymologyDebug?: RootEtymologyPreinstallDebug
  done: number
  total: number
  completedAt?: number
  error?: string
  version?: number
  senseImported?: number
  derivationImported?: number
  existingCount?: number
}

export interface EnsureDefaultGeneratedResult {
  ok: boolean
  skippedVersion: boolean
  skippedPublic: boolean
  /** Web/PWA 非原生环境跳过 */
  skippedNonNative?: boolean
  /** 已存在足够生成内容，直接跳过 */
  skippedExisting?: boolean
  existingCount?: number
  senseReport?: CoreSenseMnemonicImportReport
  derivation?: DerivationBundleImportResult
  rootEtymology?: { imported: number; total: number; stale: number; version: string }
  issues: ImportIssue[]
}

function isNativeApkRuntime(): boolean {
  try {
    const w = globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }
    return w.MomoBridge?.isNativeApp?.() === 'momo-apk'
  } catch {
    return false
  }
}

function appendNativeDiag(line: string): void {
  try {
    const bridge = (globalThis as unknown as { window?: { MomoBridge?: { appendDiagLog?: (text: string) => string } } }).window?.MomoBridge
    bridge?.appendDiagLog?.(line)
  } catch {
    // 诊断失败不影响主流程
  }
}

/** 仅 APK WebView（原生桥 isNativeApp）才允许自动导入 */

/** 已有本义助记/overview/引申图 的词数（用于重复导入快速跳过） */
async function countExistingGeneratedWords(): Promise<number> {
  const words = await getDb().words.toArray()
  return words.filter(
    (word) =>
      (word.senseMnemonics?.length ?? 0) > 0 ||
      Boolean(word.coreSenseOverview?.text) ||
      Boolean(word.derivationMap),
  ).length
}

function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl) return baseUrl
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
    if (env?.BASE_URL) return env.BASE_URL
  } catch {
    // 非 Vite 环境
  }
  return '/'
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, text: await response.text() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 过滤掉已有 manual derivationMap 的 bundle items（预生成数据不覆盖手改） */
async function filterManualDerivationItems(raw: string): Promise<string> {
  const parsed = JSON.parse(raw) as { items?: Array<{ wordId?: string; headword?: string; deckId?: string }> }
  if (!Array.isArray(parsed.items)) return raw
  const db = getDb()
  const words = await db.words.toArray()
  const manualIds = new Set<string>()
  const manualHeads = new Set<string>()
  for (const word of words) {
    if (word.derivationMap?.source !== 'manual') continue
    manualIds.add(word.id)
    manualHeads.add(`${word.deckId}\u0000${word.headwordLower}`)
  }
  parsed.items = parsed.items.filter((item) => {
    if (item.wordId && manualIds.has(item.wordId)) return false
    if (item.headword && item.deckId && manualHeads.has(`${item.deckId}\u0000${item.headword.toLowerCase()}`)) return false
    return true
  })
  return JSON.stringify(parsed)
}

/**
 * 首次启动导入私版预生成数据；可 fire-and-forget。
 * 任一文件失败只记录 issue，不写版本标记 → 下次启动重试。
 */
export async function ensureDefaultGeneratedData(
  opts: EnsureDefaultGeneratedOptions = {},
): Promise<EnsureDefaultGeneratedResult> {
  const issues: ImportIssue[] = []
  const nativeOnly = opts.nativeOnly !== false
  // 仅私版 APK 预装；私版 PWA/浏览器不跑（避免启动导入 13MB 阻塞 Web 路由）
  const includePrivate = opts.includePrivate ?? isPrivatePacksEnabled()
  if (!includePrivate) return { ok: true, skippedVersion: false, skippedPublic: true, issues }
  if (nativeOnly && !isNativeApkRuntime()) {
    return { ok: true, skippedVersion: false, skippedPublic: false, skippedNonNative: true, issues }
  }
  const db = getDb()
  if (!opts.force) {
    const row = await db.meta.get(DEFAULT_GENERATED_META_KEY)
    const value = row?.value as { version?: number } | undefined
    if (value?.version === DEFAULT_GENERATED_VERSION) {
      return { ok: true, skippedVersion: true, skippedPublic: false, issues }
    }
  }
  // 0.3.92：自动模式只允许全新空库；有学习进度即老用户，跳过自动导入（可手动立即导入）
  if (opts.autoMode) {
    const learnedCount = await db.states.count()
    if (learnedCount > 0) {
      return { ok: true, skippedVersion: false, skippedPublic: false, skippedExisting: true, existingCount: learnedCount, issues }
    }
  }
  // 0.3.92：已有生成数据（上次导入完成但 meta 丢失/旧版本）不再重复解析写入
  const existingThreshold = Math.max(1, Math.floor(opts.existingThreshold ?? 100))
  const existingCount = await countExistingGeneratedWords()
  if (!opts.force && existingCount >= existingThreshold) {
    await db.meta.put({
      key: DEFAULT_GENERATED_META_KEY,
      value: { version: DEFAULT_GENERATED_VERSION, at: Date.now(), skippedExisting: existingCount },
      updatedAt: Date.now(),
    })
    return {
      ok: true,
      skippedVersion: false,
      skippedPublic: false,
      skippedExisting: true,
      existingCount,
      issues,
    }
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) {
    return {
      ok: false,
      skippedVersion: false,
      skippedPublic: false,
      issues: [{ level: 'warning', code: 'E_IO', message: '当前环境不支持 fetch，预生成数据下次启动重试' }],
    }
  }
  const baseUrl = resolveBaseUrl(opts.baseUrl)
  let ok = true
  const progress = opts.onProgress
  // 串行化状态写入，避免进度写晚到覆盖 completed/failed
  let seedWriteQueue: Promise<void> = Promise.resolve()
  const writeSeedState = (next: Record<string, unknown>): Promise<void> => {
    seedWriteQueue = seedWriteQueue
      .then(() => db.meta.put({ key: GENERATED_SEED_STATE_KEY, value: next, updatedAt: Date.now() }))
      .then(() => undefined)
      .catch(() => undefined)
    return seedWriteQueue
  }
  const reportProgress = (phase: 'sense' | 'derivation' | 'rootEtymology', done: number, total: number) => {
    void writeSeedState({ status: 'running', phase, done, total, startedAt: Date.now() })
    progress?.({ phase, done, total })
  }
  await writeSeedState({ status: 'running', phase: 'sense', done: 0, total: 0, startedAt: Date.now() })

  // 0.3.95 P1：手动「立即导入」可能早于内置内容包 apply，导致本义全部 stale。
  // 真实 APK（未注入 fetchImpl 的测试除外）先确保内容包已导入并 apply；注入 fetch 的测试自行控制。
  if (!opts.fetchImpl) {
    try {
      const packs = await ensureDefaultContentPacks({ includePrivate })
      if (!packs.ok) {
        issues.push({
          level: 'warning',
          code: 'E_IO',
          message: `预装内容包未就绪：${packs.issues[0]?.message ?? '未知错误'}`,
        })
      }
    } catch (error) {
      issues.push({
        level: 'warning',
        code: 'E_IO',
        message: `预装内容包初始化异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // 1) 本义助记（默认 merge，不覆盖已有）
  const sense = await fetchText(joinUrl(baseUrl, GENERATED_SENSE_MNEMONICS_PATH), fetchImpl)
  let senseReport: CoreSenseMnemonicImportReport | undefined
  if (!sense.ok) {
    ok = false
    issues.push({
      level: 'warning',
      code: 'E_IO',
      message: `本义助记预生成数据加载失败：${sense.error}（下次启动重试）`,
    })
  } else {
    try {
      const preview = await previewCoreSenseMnemonicImport(sense.text, {
          onProgress: (p) => reportProgress('sense', p.done, p.total),
        })
      if (!preview.ok) {
        ok = false
        issues.push({ level: 'warning', code: 'E_FORMAT', message: '本义助记预生成数据格式不合法' })
      } else {
        senseReport = await applyCoreSenseMnemonicImportParsed(preview, {
          onProgress: (p) => reportProgress('sense', p.done, p.total),
        })
        if (!senseReport.ok) {
          ok = false
          issues.push({ level: 'warning', code: 'E_IO', message: '本义助记预生成数据导入失败' })
        } else if (senseReport.counts.sensesImported === 0 && senseReport.counts.stale > 0) {
          // 0.3.95 P1：内容包未 apply 时全部 stale，不能标记完成（否则真机显示 0 条且不再重试）
          ok = false
          issues.push({
            level: 'warning',
            code: 'E_FIELD',
            message: `本义助记与当前本义不匹配（${senseReport.counts.stale} 条 stale），等待内容包就绪后重试`,
          })
        }
      }
    } catch (error) {
      ok = false
      issues.push({
        level: 'warning',
        code: 'E_IO',
        message: `本义助记预生成数据导入异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // 2) 引申图 bundle（跳过已有 manual）
  const derivation = await fetchText(joinUrl(baseUrl, GENERATED_DERIVATION_BUNDLE_PATH), fetchImpl)
  let derivationResult: DerivationBundleImportResult | undefined
  if (!derivation.ok) {
    ok = false
    issues.push({
      level: 'warning',
      code: 'E_IO',
      message: `引申图预生成数据加载失败：${derivation.error}（下次启动重试）`,
    })
  } else {
    try {
      const filtered = await filterManualDerivationItems(derivation.text)
      derivationResult = await importDerivationBundle(filtered, {
        mode: 'merge',
        // 预装 bundle 实测 6.2MB，超过用户手动导入的 5MB 限制；内部信任资源放宽
        maxBytes: 20 * 1024 * 1024,
        ...(opts.onProgress
          ? { onProgress: (p) => reportProgress('derivation', p.done, p.total) }
          : {}),
      })
      if (derivationResult.failed > 0) {
        ok = false
        issues.push({ level: 'warning', code: 'E_IO', message: `引申图预生成数据 ${derivationResult.failed} 条失败` })
      }
    } catch (error) {
      ok = false
      issues.push({
        level: 'warning',
        code: 'E_IO',
        message: `引申图预生成数据导入异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  if (ok) {
    await db.meta.put({
      key: DEFAULT_GENERATED_META_KEY,
      value: {
        version: DEFAULT_GENERATED_VERSION,
        at: Date.now(),
        senseImported: senseReport?.counts.sensesImported ?? 0,
        derivationImported: derivationResult?.imported ?? 0,
      },
      updatedAt: Date.now(),
    })
    await writeSeedState({
      status: 'completed',
      completedAt: Date.now(),
      senseImported: senseReport?.counts.sensesImported ?? 0,
      derivationImported: derivationResult?.imported ?? 0,
    })
  } else {
    await writeSeedState({ status: 'failed', error: issues[0]?.message ?? '未知错误', failedAt: Date.now() })
    appendNativeDiag(`[generated-seed] failed: ${issues.map((issue) => issue.message).join(' | ').slice(0, 500)}`)
  }
  return {
    ok,
    skippedVersion: false,
    skippedPublic: false,
    ...(senseReport ? { senseReport } : {}),
    ...(derivationResult ? { derivation: derivationResult } : {}),
    issues,
  }
}

/** 纯产物存在性自检（构建/测试用）：确保私版资源路径已打进 public/ */
export function defaultGeneratedPaths(): string[] {
  return [GENERATED_SENSE_MNEMONICS_PATH, GENERATED_DERIVATION_BUNDLE_PATH]
}

/** 0.3.92：预装内容状态（我的→数据 状态行/进度条用） */
export async function getGeneratedSeedStatus(): Promise<GeneratedSeedStatus> {
  const includePrivate = isPrivatePacksEnabled()
  if (!includePrivate) return { supported: false, state: 'skipped-public', done: 0, total: 0 }
  if (!isNativeApkRuntime()) return { supported: false, state: 'skipped-non-native', done: 0, total: 0 }
  const db = getDb()
  const [seeded, stateRow, rootMeta] = await Promise.all([
    db.meta.get(DEFAULT_GENERATED_META_KEY),
    db.meta.get(GENERATED_SEED_STATE_KEY),
    getRootEtymologyPreinstallStatus(),
  ])
  const rootFields = rootMeta
    ? {
        rootEtymologyImported: rootMeta.count,
        rootEtymologyTotal: rootMeta.total,
        rootEtymologyVersion: rootMeta.version,
        rootEtymologyState: rootMeta.state,
        ...(rootMeta.error ? { rootEtymologyError: rootMeta.error } : {}),
        ...(rootMeta.debug ? { rootEtymologyDebug: rootMeta.debug } : {}),
      }
    : {}
  const seededValue = seeded?.value as
    | {
        version?: number
        at?: number
        senseImported?: number
        derivationImported?: number
        skippedExisting?: number
        rootEtymologyImported?: number
        rootEtymologyTotal?: number
        rootEtymologyVersion?: string
      }
    | undefined
  const stateValue = stateRow?.value as
    | { status?: GeneratedSeedState; phase?: 'sense' | 'derivation'; done?: number; total?: number; completedAt?: number; error?: string }
    | undefined
  if (stateValue?.status === 'running') {
    return {
      supported: true,
      state: 'running',
      ...(stateValue.phase ? { phase: stateValue.phase } : {}),
      done: stateValue.done ?? 0,
      total: stateValue.total ?? 0,
      ...rootFields,
    }
  }
  if (seededValue?.version === DEFAULT_GENERATED_VERSION) {
    return {
      supported: true,
      state: seededValue.skippedExisting != null ? 'skipped-existing' : 'completed',
      done: 0,
      total: 0,
      ...(seededValue.at ? { completedAt: seededValue.at } : {}),
      ...(seededValue.version ? { version: seededValue.version } : {}),
      ...(seededValue.senseImported != null ? { senseImported: seededValue.senseImported } : {}),
      ...(seededValue.derivationImported != null ? { derivationImported: seededValue.derivationImported } : {}),
      ...(seededValue.skippedExisting != null ? { existingCount: seededValue.skippedExisting } : {}),
      ...(Object.keys(rootFields).length > 0
        ? rootFields
        : seededValue.rootEtymologyImported != null
          ? {
              rootEtymologyImported: seededValue.rootEtymologyImported,
              rootEtymologyTotal: seededValue.rootEtymologyTotal,
              rootEtymologyVersion: seededValue.rootEtymologyVersion,
            }
          : {}),
    }
  }
  if (stateValue?.status === 'failed') {
    return { supported: true, state: 'failed', done: 0, total: 0, ...(stateValue.error ? { error: stateValue.error } : {}), ...rootFields }
  }
  return { supported: true, state: 'idle', done: 0, total: 0, ...rootFields }
}

/** 手动立即导入（我的→数据「预装内容」失败重试/立即导入） */
export async function forceImportDefaultGeneratedData(): Promise<EnsureDefaultGeneratedResult> {
  return ensureDefaultGeneratedData({ force: true, existingThreshold: Number.MAX_SAFE_INTEGER })
}
