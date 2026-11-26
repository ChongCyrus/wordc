/**
 * 导入 / 导出（SPEC §6，AC5）。
 *
 * 三种文件：
 * - DeckFile v1（`momo-deck`）：纯词库，可公开分享，不含学习状态（§6.1）；
 * - MigrationFile v1（`momo-migration`）：词库 + 学习状态 + 设置 + 版本号 + checksum（§6.2, D22）；
 * - CSV（§6.3）：用户自己的词单（一行一词，多义用 `；` 分隔）。
 *
 * 导入流程统一为：**先校验后写库**；任何 error 级 issue → 整体不写库（ok:false）。
 * 导入结果写 `meta:import:last`，设置页展示（§2.2）。
 */

import { localDateKey, newDeckId } from '../core'
import type {
  Deck,
  DeckFile,
  ImportIssue,
  ImportReport,
  MigrationFile,
  ReviewLog,
  SettingRecord,
  Word,
  WordState,
} from '../core'
import type { DailyPlan } from './plan.types'
import { computeChecksum, migrationChecksumPayload, stableStringify, stableStringifyAsync } from './checksum'
import type { ChecksumAlgo } from './checksum'
import { getDb } from './db'
import { diffReplaceDeckWords, scrubPlansForRemovedWords } from './word-mutation'
import { withDataWriteLock } from './write-lock'
import { bumpDataEpoch } from './data-epoch'
import { assertIdbMutationAllowed, getLearningWriteSource, persistLearningWriteSource } from './learning-write-source'
import { clearAllSqliteFacts, clearSqliteFactsTables } from './sqlite-clear'
import { isSqliteAvailable, sqliteQuery, sqliteTx } from './native-sqlite'
import { createSqliteFactsBackup, createSafetySnapshot, restoreSqliteFactsBackup } from './sqlite-backup'
import { migrateIdbToSqlite, SQLITE_MIGRATION_STEP, stateRow as migrationStateRow, planRow as migrationPlanRow, logRow as migrationLogRow, settingRow as migrationSettingRow } from './migration-sqlite'
import { rebuildIdbCacheFromSqlite } from './cache-rebuild'
import { deleteStateCheckpointFiles } from './state-checkpoint'
import type { AutoBackupBridge } from './auto-backup'
import { csvToWordInputs, parseCsv } from './csv'
import { contentRowOfDeck, contentRowOfWord, ensureSingleDefaultDeck } from './decks.repo'
import { wordOverlayOf } from './content-snapshot'
import { ContentWriteError, getContentWriteSource, saveContentEntitiesChunked } from './content-write-source'
import type { ContentEntityRow } from './content-write-source'
import { getContentMigrationState } from './content-migration-plan'
import { ensureContentSourceAfterImport } from './content-switch'
import { listContentByRevision, readContentRevision, writeContentRows } from './content-store'
import type { ContentKvRow } from './content-store'
import type { ParsedMigrationFile } from './schema'
import type { ContentRejectRecord, PackItemRecord, PackRecord } from './packs/schema'
import { DECK_SOURCES } from './builtin/deck-sources'
import { ensureBuiltinDeckWords } from './builtin'
import { makeIssue, parseDeckFile, parseMigrationFile } from './schema'
import { applyImportedSettings, getSettings } from './settings.repo'
import type { RawWordInput } from './word-factory'

export const GENERATOR = 'wordc@0.18.5'
export const APP_VERSION = '0.18.5'

/** 迁移包导出选项 */
export interface ExportOptions {
  /** 是否包含复习日志（默认 true；最多 20000 条） */
  includeReviewLogs?: boolean
  /** 复习日志条数上限（默认 20000，§6.2） */
  maxReviewLogs?: number
  /**
   * 0.3.61：是否包含全量 derivationMap（默认 **false**）。
   * 引申图体积可达数 MB，应使用「我的→数据→整库引申图」bundle 单独导出；
   * false 时迁移包仍包含 words/notes/nc/rootMnemonic/rareMeaningIds/states/settings。
   */
  includeDerivationMaps?: boolean
  /**
   * 0.3.61：是否包含内容包三表（默认 **false**）。
   * 内容包体积大，可单独用内容包导出；false 时迁移包不含 packs/packItems/contentRejects。
   */
  includeContentPacks?: boolean
  /**
   * 0.3.63：导出前体积硬性上限（字节）。超过则抛 MigrationTooLargeError，**不构建大字符串/不 base64**，
   * 避免 WebView OOM。UI 完整备份建议传 24MB 左右；轻量备份可不传。
   */
  maxBytes?: number
}

/** 完整备份安全上限（0.16.0：真机完整备份 21.2MB，提高到 64MB；仍防极端 OOM，超过则引导分项导出） */
export const FULL_BACKUP_MAX_BYTES = 64 * 1024 * 1024

export class MigrationTooLargeError extends Error {
  readonly estimatedBytes: number
  readonly maxBytes: number
  constructor(estimatedBytes: number, maxBytes: number) {
    const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`
    super(
      `迁移包预计 ${mb(estimatedBytes)}，超过安全上限 ${mb(maxBytes)}，已取消导出（不会生成文件，避免 App 崩溃）。` +
        '请改用：导出学习进度（轻量）+ 导出全部引申图 + 内容包导出；需要完整恢复时分别导入。',
    )
    this.name = 'MigrationTooLargeError'
    this.estimatedBytes = estimatedBytes
    this.maxBytes = maxBytes
  }
}

export interface MigrationSizeEstimate {
  bytes: number
  breakdown: {
    words: number
    derivationMaps: number
    states: number
    reviewLogs: number
    settings: number
    packs: number
    packItems: number
    contentRejects: number
  }
}

/** 导入选项（§9.3） */
export type MigrationImportPhase = 'read' | 'parse' | 'checksum' | 'validate' | 'apply' | 'done'

export interface MigrationImportProgress {
  phase: MigrationImportPhase
  message?: string
}

export interface ImportSqliteStageImpl {
  createBackup?: typeof createSqliteFactsBackup
  restoreBackup?: typeof restoreSqliteFactsBackup
  clearFacts?: typeof clearAllSqliteFacts
  migrate?: typeof migrateIdbToSqlite
  rebuildCache?: typeof rebuildIdbCacheFromSqlite
  health?: () => Promise<{ counts?: Record<string, number>; ok?: boolean; message?: string }>
  /** 测试/注入：清 migration_state 的 legacy-idb done 标记 */
  resetMigrationState?: () => Promise<void>
}

export interface ImportOptions {
  strategy?: 'replace' | 'merge' | 'keepNewer'
  /** checksum 不符仍导入（UI「仍要导入（风险）」按钮） */
  force?: boolean
  /** 0.3.95：大文件恢复进度（仅阶段，不表示每表进度） */
  onProgress?: (progress: MigrationImportProgress) => void
  /** 0.10.0：恢复超时/取消检查；每个写批次前调用，返回 true 则中止导入 */
  shouldAbort?: () => boolean
  /** 0.10.0：调用方已持有全局写锁（restore 内部用），避免嵌套死锁 */
  skipWriteLock?: boolean
  /** A3：sqlite 模式导入前强制完整备份（失败拒绝） */
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  /** A3：测试注入 SQLite staging 实现 */
  sqliteStageImpl?: ImportSqliteStageImpl
}

/**
 * 迁移包 v2（formatVersion 保持 1；只加可选字段）：
 * - `data.plans?`：只带导出当天的今日计划（≤1–2 条，跨设备续学）；
 * - `counts.plans?`：旧文件缺省 0；
 * - `meta.checksumAlgo`：checksum 算法标注（§6.2）。
 */
export type MigrationFileWithMeta = MigrationFile & {
  counts: MigrationFile['counts'] & { plans?: number }
  data: MigrationFile['data'] & { plans?: DailyPlan[] }
  meta?: { checksumAlgo?: ChecksumAlgo; excluded?: string[] }
}

const EMPTY_COUNTS: ImportReport['counts'] = {
  decks: 0,
  words: 0,
  states: 0,
  reviewLogs: 0,
  skipped: 0,
}

function makeReport(
  kind: ImportReport['kind'],
  issues: ImportIssue[],
  counts: Partial<ImportReport['counts']>,
  durationMs: number,
): ImportReport {
  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    kind,
    counts: { ...EMPTY_COUNTS, ...counts },
    issues,
    durationMs,
  }
}

/** 统一读入文本（string 或 File/Blob） */
async function readInput(input: string | File): Promise<string> {
  if (typeof input === 'string') return input
  if (input && typeof (input as File).text === 'function') return (input as File).text()
  throw new Error('无法读取文件内容')
}

async function parseJsonText(text: string): Promise<{ ok: true; value: unknown } | { ok: false; issues: ImportIssue[] }> {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return { ok: false, issues: [makeIssue('error', 'E_FORMAT', '文件是空的')] }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return {
      ok: false,
      issues: [
        makeIssue('error', 'E_FORMAT', `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`),
      ],
    }
  }
}

async function writeLastImport(report: ImportReport): Promise<void> {
  try {
    const db = getDb()
    await db.meta.put({
      key: 'import:last',
      value: { at: Date.now(), kind: report.kind, report },
      updatedAt: Date.now(),
    })
  } catch {
    // 记录上次导入失败不该影响主流程
  }
}

/** 分批写词条/状态（手机端 bulkPut 500 条更稳，§6.5） */
const CHUNK = 500
async function bulkPutChunked<T>(table: { bulkPut: (items: T[]) => Promise<unknown> }, items: T[]): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    await table.bulkPut(items.slice(i, i + CHUNK))
  }
}

function uniqueDeckName(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`
    if (!existing.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

/** 词库文件名（UI 下载用）：非法字符替换为 _ */
export function deckFileName(deck: Pick<Deck, 'name'>): string {
  const safe = deck.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80)
  return `${safe || 'deck'}.deck.json`
}

/** 迁移包文件名（UI 下载用） */
export function migrationFileName(now: number = Date.now()): string {
  return `momo-backup-${localDateKey(now)}.migration.json`
}

// ============ 导出 ============

/** 构造纯词库文件（DeckFile v1） */
export async function buildDeckFile(deckId: string, now: number = Date.now()): Promise<DeckFile> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const words = await db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .toArray()
  const meta: DeckFile['meta'] = { wordCount: words.length }
  if (deck.license) {
    meta.license = deck.license
    if (deck.source === 'builtin') meta.copyrightNotice = deck.license
  }
  return {
    format: 'momo-deck',
    formatVersion: 1,
    exportedAt: now,
    generator: GENERATOR,
    deck: { ...deck, wordCount: words.length, updatedAt: now },
    words,
    meta,
  }
}

/** 导出纯词库（不含学习状态，可公开分享） */
export async function exportDeck(deckId: string): Promise<Blob> {
  const file = await buildDeckFile(deckId)
  return new Blob([stableStringify(file)], { type: 'application/json' })
}

/**
 * 0.3.61：旧包/轻量包缺字段时，merge/keepNewer 保留本机用户内容（避免导入旧备份把新数据清空）。
 * replace 模式不保留（除 derivationMap 在包声明 excluded 时单独快照保护）。
 */
const OPTIONAL_USER_FIELDS: Array<keyof Word> = [
  'derivationMap',
  'ncMeaningIds',
  'rootMnemonic',
  'rareMeaningIds',
  'rareMarkCheckedAt',
  'rareMarkVersion',
  'rootEtymology',
  'rootEtymologyCheckedAt',
  'rootEtymologyVersion',
  'userNotes',
  'userMnemonics',
  'hiddenMnemonicKeys',
]

function preserveLocalUserFields(imported: Word, local: Word | undefined): Word {
  if (!local) return imported
  let next = imported
  for (const field of OPTIONAL_USER_FIELDS) {
    if (next[field] === undefined && local[field] !== undefined) {
      if (next === imported) next = { ...imported }
      ;(next as unknown as Record<string, unknown>)[field] = local[field]
    }
  }
  return next
}

/** 构造可迁移包（含 states/settings，checksum） */
/** 估算 migration JSON 体积（逐项 stringify 后累加；不一次性拼大字符串，供 OOM 预检） */
export async function estimateMigrationBytes(opts: ExportOptions = {}): Promise<MigrationSizeEstimate> {
  const db = getDb()
  const [decks, words, states, settingRows] = await Promise.all([
    db.decks.toArray(),
    db.words.toArray(),
    db.states.toArray(),
    db.settings.toArray(),
  ])
  let derivationMaps = 0
  let wordBytes = 0
  for (const word of words) {
    const mapBytes = word.derivationMap ? JSON.stringify(word.derivationMap).length : 0
    derivationMaps += mapBytes
    wordBytes += JSON.stringify(word).length + 1
  }
  let reviewLogs = 0
  if (opts.includeReviewLogs !== false) {
    const max = Math.max(0, Math.floor(opts.maxReviewLogs ?? 20000))
    if (max > 0) {
      const rows = await db.reviewLogs.orderBy('reviewedAt').reverse().limit(max).toArray()
      reviewLogs = rows.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
    }
  }
  let packs = 0
  let packItems = 0
  let contentRejects = 0
  if (opts.includeContentPacks === true) {
    const [packRows, itemRows, rejectRows] = await Promise.all([
      db.packs.toArray(),
      db.packItems.toArray(),
      db.contentRejects.toArray(),
    ])
    packs = packRows.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
    packItems = itemRows.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
    contentRejects = rejectRows.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
  }
  const statesBytes = states.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
  const settingsBytes = settingRows.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
  const decksBytes = decks.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
  const bytes =
    wordBytes + statesBytes + reviewLogs + settingsBytes + decksBytes + packs + packItems + contentRejects
  return {
    bytes,
    breakdown: {
      words: wordBytes,
      derivationMaps,
      states: statesBytes,
      reviewLogs,
      settings: settingsBytes,
      packs,
      packItems,
      contentRejects,
    },
  }
}

async function assertExportCacheFresh(): Promise<void> {
  const { getLearningWriteSource } = await import('./learning-write-source')
  if ((await getLearningWriteSource()) !== 'sqlite') return
  const { flushRatingCacheWarmup } = await import('./study-sqlite')
  await flushRatingCacheWarmup()
  const { getIdbCacheMeta } = await import('./idb-cache')
  let meta = await getIdbCacheMeta()
  if (meta?.dirty !== true) return
  const { rebuildIdbCacheFromSqlite } = await import('./cache-rebuild')
  const rebuilt = await rebuildIdbCacheFromSqlite().catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  if (!rebuilt.ok) throw new Error(`导出前缓存刷新失败，拒绝导出陈旧备份：${(rebuilt as { error?: string }).error ?? '未知错误'}`)
  meta = await getIdbCacheMeta()
  if (!meta || meta.dirty) throw new Error('导出前缓存仍为 dirty，拒绝导出陈旧备份')
}

export async function buildMigrationFile(opts: ExportOptions = {}): Promise<MigrationFileWithMeta> {
  await assertExportCacheFresh()
  const db = getDb()
  const now = Date.now()
  const [decks, rawWords, states, settingRows] = await Promise.all([
    db.decks.toArray(),
    db.words.toArray(),
    db.states.toArray(),
    db.settings.toArray(),
  ])
  const includeDerivationMaps = opts.includeDerivationMaps === true
  // 0.3.61：默认轻量迁移（不含 ~MB 级 derivationMap），避免 WebView 桥 base64 OOM；
  // 需要完整备份时显式 includeDerivationMaps/includeContentPacks。
  const words: Word[] = includeDerivationMaps
    ? rawWords
    : rawWords.map((word) => {
        if (!word.derivationMap) return word
        const { derivationMap: _omitted, ...rest } = word
        return rest
      })
  let reviewLogs: ReviewLog[] = []
  if (opts.includeReviewLogs !== false) {
    const max = Math.max(0, Math.floor(opts.maxReviewLogs ?? 20000))
    if (max > 0) {
      const tail = await db.reviewLogs.orderBy('reviewedAt').reverse().limit(max).toArray()
      reviewLogs = tail.sort((a, b) => a.reviewedAt - b.reviewedAt)
    }
  }
  // 隐私（D23/task-70）：MaiMemo token 与 AI Key 永不进迁移包
  const settings: SettingRecord[] = settingRows.filter(
    (record) => record.key !== 'data.maimemoToken' && record.key !== 'ai.apiKey',
  )
  // v2：只带导出当天的今日计划（最多 2 条：一天内切换词库的情况）
  const todayKey = localDateKey(now)
  const plans = await db.plans.where('date').equals(todayKey).limit(2).toArray()
  // v3（task-69）：内容包三表随迁移包导出（备份/换机保留 AI 生成内容与拒绝记忆）
  // 0.3.61：默认排除（体积大；内容包有单独导出），显式 includeContentPacks 才读取
  const includeContentPacks = opts.includeContentPacks === true
  const [contentPacks, packItems, contentRejects] = includeContentPacks
    ? await Promise.all([db.packs.toArray(), db.packItems.toArray(), db.contentRejects.toArray()])
    : [[], [], []]
  const excluded: string[] = []
  if (!includeDerivationMaps) excluded.push('derivationMap')
  if (!includeContentPacks) excluded.push('contentPacks')
  const data: MigrationFileWithMeta['data'] = {
    decks,
    words,
    states,
    reviewLogs,
    settings,
    ...(plans.length > 0 ? { plans } : {}),
    ...(contentPacks.length > 0 ? { contentPacks } : {}),
    ...(packItems.length > 0 ? { packItems } : {}),
    ...(contentRejects.length > 0 ? { contentRejects } : {}),
  }
  const payload = {
    format: 'momo-migration' as const,
    formatVersion: 1 as const,
    dataVersion: 1 as const,
    data,
  }
  const checksum = await computeChecksum(migrationChecksumPayload(payload))
  return {
    format: 'momo-migration',
    formatVersion: 1,
    exportedAt: now,
    generator: GENERATOR,
    appVersion: APP_VERSION,
    dataVersion: 1,
    counts: {
      decks: decks.length,
      words: words.length,
      states: states.length,
      reviewLogs: reviewLogs.length,
      ...(plans.length > 0 ? { plans: plans.length } : {}),
    },
    data,
    checksum: checksum.hex,
    meta: { checksumAlgo: checksum.algo, ...(excluded.length > 0 ? { excluded } : {}) },
  }
}

/** 导出可迁移包（备份/跨设备迁移） */
export async function exportMigration(opts: ExportOptions = {}): Promise<Blob> {
  // 0.3.63：完整备份先做体积预检（逐项估算，不构建完整 JSON/base64），超过硬上限直接拒绝，避免 OOM
  if (opts.maxBytes && opts.maxBytes > 0) {
    const estimate = await estimateMigrationBytes(opts)
    if (estimate.bytes > opts.maxBytes) {
      throw new MigrationTooLargeError(estimate.bytes, opts.maxBytes)
    }
  }
  const file = await buildMigrationFile(opts)
  return new Blob([stableStringify(file)], { type: 'application/json' })
}

/**
 * 0.4.0/task-282：自动备份专用异步导出文本。
 * buildMigrationFile 后分片 stableStringifyAsync，每 ~128KB / 200 字段让出主线程；
 * 内容与 exportMigration 的 Blob 文本一致。
 */
export async function exportMigrationText(
  opts: ExportOptions & { onProgress?: (progress: { phase: 'build' | 'stringify'; chars?: number }) => void } = {},
): Promise<string> {
  if (opts.maxBytes && opts.maxBytes > 0) {
    const estimate = await estimateMigrationBytes(opts)
    if (estimate.bytes > opts.maxBytes) throw new MigrationTooLargeError(estimate.bytes, opts.maxBytes)
  }
  opts.onProgress?.({ phase: 'build' })
  const file = await buildMigrationFile(opts)
  opts.onProgress?.({ phase: 'stringify', chars: 0 })
  return stableStringifyAsync(file, {
    onProgress: (chars) => opts.onProgress?.({ phase: 'stringify', chars }),
  })
}

// ============ 导入：纯词库 ============

/** 导入 DeckFile（strategy 默认 replace：同 id 清空该库 words/states 再写） */
export function importDeckFile(
  input: string | File,
  opts: ImportOptions & {
    preBackup?: () => Promise<void | { ok: boolean; error?: string }>
    unsafe?: boolean
  } = {},
): Promise<ImportReport> {
  if (getLearningWriteSource() === 'sqlite') {
    return withDataWriteLock(() => importDeckFileSqlite(input, opts))
  }
  if (!opts.unsafe) assertIdbMutationAllowed('导入词库文件')
  return withDataWriteLock(() => importDeckFileInner(input, opts))
}

/** sqlite 模式导入纯词库：只写 IDB decks/words cache；已有词库（可能含 SQLite states）拒绝覆盖。 */
async function importDeckFileSqlite(
  input: string | File,
  opts: ImportOptions & { preBackup?: () => Promise<void | { ok: boolean; error?: string }>; unsafe?: boolean } = {},
): Promise<ImportReport> {
  const startedAt = Date.now()
  const returnReport = async (report: ImportReport): Promise<ImportReport> => { await writeLastImport(report); return report }
  if (!opts.unsafe && opts.preBackup) {
    const backup = await opts.preBackup()
    if (backup && backup.ok === false) throw new Error(`预备份失败，已拒绝导入：${backup.error ?? '未知错误'}`)
  }
  const text = await readInput(input)
  const json = await parseJsonText(text)
  if (!json.ok) return returnReport(makeReport('deck', json.issues, {}, Date.now() - startedAt))
  const parsed = parseDeckFile(json.value)
  if (!parsed.ok) return returnReport(makeReport('deck', parsed.issues, {}, Date.now() - startedAt))
  if (parsed.value.issues.some((issue) => issue.level === 'error')) {
    return returnReport(makeReport('deck', parsed.value.issues, {}, Date.now() - startedAt))
  }
  const db = getDb()
  const existing = await db.decks.get(parsed.value.deck.id)
  if (existing) {
    throw new Error('E_UNSUPPORTED: sqlite 模式暂不支持覆盖已有词库（含学习状态）；请新建词库导入，或先 0.10/0.11.1')
  }
  const sqliteStates = await sqliteQuery({ table: 'states', where: { deck_id: parsed.value.deck.id }, limit: 1 }, 5_000).catch(() => null)
  if (((sqliteStates?.rows as unknown[] | undefined) ?? []).length > 0) {
    throw new Error('E_UNSUPPORTED: 该词库已有 SQLite 学习状态，禁止覆盖')
  }
  const report = await importDeckFileInner(input, { ...opts, unsafe: true })
  return report
}

// ============ 0.14 B4：sqlite 内容写源的导入写路径 ============

/** 内置词库文件（正文来自打包资源，不进 content_kv） */
function isBuiltinDeckFile(deck: Deck): boolean {
  if (deck.builtinKey) return true
  if (deck.source === 'builtin') return true
  return DECK_SOURCES.some((source) => source.deckId === deck.id)
}

/**
 * sqlite 内容写源导入安全校验：
 * - 内置词库（正文来自资源）不能覆盖进 content_kv；
 * - 新建库时不得有残留词条/SQLite 学习状态（cache 与内容库不一致）。
 */
async function assertContentSqliteDeckImportable(deckId: string, existingDeck: Deck | null): Promise<void> {
  const db = getDb()
  if (existingDeck) {
    if (isBuiltinDeckFile(existingDeck)) {
      throw new Error('E_UNSUPPORTED: sqlite 内容写源下内置词库正文不进 content_kv；不能覆盖内置词库')
    }
    return
  }
  if ((await db.words.where('deckId').equals(deckId).count()) > 0) {
    throw new Error('E_UNSUPPORTED: 目标词库仍有词条（cache 与内容库不一致），禁止覆盖')
  }
  const sqliteStates = await sqliteQuery({ table: 'states', where: { deck_id: deckId }, limit: 1 }, 5_000).catch(() => null)
  if (((sqliteStates?.rows as unknown[] | undefined) ?? []).length > 0) {
    throw new Error('E_UNSUPPORTED: 该词库已有 SQLite 学习状态，禁止覆盖')
  }
}

/**
 * sqlite 内容写源导入纯词库：deck/word 先写 content_kv（≤500/批），成功后才由写源 helper 写 IDB cache；
 * 失败返回结构化 report（含已写条数），不写 IDB。
 * - 新建自定义词库：全量写 deck+word；
 * - 已有自定义词库：replace 时对不在新词表的旧词写 tombstone 并清 facts（states/logs/plans），merge 只 upsert；
 * - 内置词库正文一律 fail-closed（正文来自资源，不进 content_kv）。
 */
async function importDeckFileContentSqlite(args: {
  deck: Deck
  words: Word[]
  issues: ImportIssue[]
  startedAt: number
  now: number
  strategy: 'replace' | 'merge' | 'keepNewer'
  opts: ImportOptions & { preBackup?: () => Promise<void | { ok: boolean; error?: string }>; unsafe?: boolean }
}): Promise<ImportReport> {
  const { deck, words, issues, startedAt, now, strategy, opts } = args
  const db = getDb()
  const returnReport = async (report: ImportReport): Promise<ImportReport> => { await writeLastImport(report); return report }
  if (isBuiltinDeckFile(deck)) {
    throw new Error('E_UNSUPPORTED: sqlite 内容写源下内置词库正文不进 content_kv；请通过内置词表/资源恢复')
  }
  const existingDeck = (await db.decks.get(deck.id)) ?? null
  await assertContentSqliteDeckImportable(deck.id, existingDeck)
  // 0.10.0：replace 会删同库词条/states；已有数据时必须先成功预备份（与 idb 路径同语义）
  if (strategy === 'replace' && !opts.unsafe && existingDeck) {
    const [existingWords, existingStates] = await Promise.all([
      db.words.where('deckId').equals(deck.id).count(),
      db.states.where('deckId').equals(deck.id).count(),
    ])
    if (existingWords > 0 || existingStates > 0) {
      if (!opts.preBackup) throw new Error('替换词库会删除现有词条/学习状态，必须先备份')
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) throw new Error(`预备份失败，已拒绝替换：${backup.error ?? '未知错误'}`)
    }
  }
  const existingDefaultId = (await db.decks.toArray()).find((item) => item.isDefault)?.id ?? null
  const existingWords = existingDeck ? await db.words.where('deckId').equals(deck.id).toArray() : []
  const newWordIds = new Set(words.map((word) => word.id))
  const removed = strategy === 'replace' ? existingWords.filter((word) => !newWordIds.has(word.id)) : []
  const nextDeck: Deck = { ...deck, createdAt: existingDeck?.createdAt ?? deck.createdAt ?? now, updatedAt: now }
  const rows = [
    contentRowOfDeck(nextDeck),
    ...words.map((word) => contentRowOfWord(word, now)),
    ...removed.map((word) => ({ key: `word:${word.id}`, kind: 'word' as const, json: 'null', deleted: true, updatedAt: now })),
  ]
  const saved = await saveContentEntitiesChunked(rows)
  if (!saved.ok) {
    return returnReport(makeReport(
      'deck',
      [...issues, makeIssue('error', 'E_IO', `SQLite 内容写入失败（已写 ${saved.written}/${rows.length} 条，失败批未回写 IDB）：${saved.error ?? '未知错误'}`, { path: 'data' })],
      { decks: saved.written > 0 ? 1 : 0, words: Math.max(0, saved.written - 1) },
      Date.now() - startedAt,
    ))
  }
  // replace：facts 清理（states/logs/plans；与 idb 的 diffReplaceDeckWords 语义对齐）
  if (strategy === 'replace' && existingDeck) {
    const removedIds = removed.map((word) => word.id)
    await db.transaction('rw', [db.states, db.plans, db.reviewLogs, db.meta], async () => {
      if (removedIds.length > 0) await db.reviewLogs.where('wordId').anyOf(removedIds).delete()
      await db.states.where('deckId').equals(deck.id).delete()
    })
    if (removedIds.length > 0) {
      await scrubPlansForRemovedWords(removedIds, { deckId: deck.id, now })
      await db.meta.put({
        key: 'diag.lastWordMutation',
        value: { reason: 'import-deck-replace', deckId: deck.id, upserted: words.length, removed: removedIds.length, at: now },
        updatedAt: now,
      }).catch(() => undefined)
    }
  }
  // 非内容事实（settings 选中词库）保持原语义
  const selected = await db.settings.get('data.selectedDeckId')
  const selectedDeck = selected ? await db.decks.get(selected.value as string) : undefined
  if (!selectedDeck) {
    await db.settings.put({ key: 'data.selectedDeckId', value: deck.id, updatedAt: now })
  }
  // deck 默认标记也是内容：ensureSingleDefaultDeck 在 sqlite 内容写源下自行同步 content_kv
  await ensureSingleDefaultDeck(existingDefaultId)
  const report = makeReport(
    'deck',
    issues,
    { decks: 1, words: words.length, skipped: issues.filter((i) => i.code === 'W_SKIPPED').length },
    Date.now() - startedAt,
  )
  await writeLastImport(report)
  return report
}

async function importDeckFileInner(
  input: string | File,
  opts: ImportOptions & {
    /** 0.10.0：replace 且目标库已有 words/states 时必须先成功的预备份 */
    preBackup?: () => Promise<void | { ok: boolean; error?: string }>
    /** 仅供内部测试/重置；UI 不得使用 */
    unsafe?: boolean
  } = {},
): Promise<ImportReport> {
  const startedAt = Date.now()
  const strategy = opts.strategy ?? 'replace'
  opts.onProgress?.({ phase: 'read', message: '读取备份文本' })
  const text = await readInput(input)
  opts.onProgress?.({ phase: 'parse', message: '解析 JSON' })
  const json = await parseJsonText(text)
  if (!json.ok) {
    const report = makeReport('deck', json.issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const parsed = parseDeckFile(json.value)
  if (!parsed.ok) {
    const report = makeReport('deck', parsed.issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const issues = parsed.issues
  if (issues.some((issue) => issue.level === 'error')) {
    const report = makeReport('deck', issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }

  const db = getDb()
  const { deck, words } = parsed.value
  const now = Date.now()
  // 0.14 B4：sqlite 内容写源——deck/word 先写 content_kv；失败返回结构化 report 且不写 IDB
  if ((await getContentWriteSource()) === 'sqlite') {
    return importDeckFileContentSqlite({ deck, words, issues, startedAt, now, strategy, opts })
  }
  // 0.10.0：replace 会删除同库 words/states；已有数据时必须先成功预备份
  if (strategy === 'replace' && !opts.unsafe) {
    const [existingWords, existingStates] = await Promise.all([
      db.words.where('deckId').equals(deck.id).count(),
      db.states.where('deckId').equals(deck.id).count(),
    ])
    if (existingWords > 0 || existingStates > 0) {
      if (!opts.preBackup) throw new Error('替换词库会删除现有词条/学习状态，必须先备份')
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) throw new Error(`预备份失败，已拒绝替换：${backup.error ?? '未知错误'}`)
    }
  }
  const existingDefaultId =
    (await db.decks.toArray()).find((item) => item.isDefault)?.id ?? null
  await db.transaction('rw', [db.decks, db.words, db.states, db.plans, db.reviewLogs, db.settings, db.meta], async () => {
    const existingDeck = await db.decks.get(deck.id)
    if (strategy === 'replace') {
      // 0.10.0：diff 替换；只删新词表不存在的旧 wordId，并重映射 plans/日志
      await diffReplaceDeckWords(deck.id, words, 'import-deck-replace')
      // 词库文件不含 states：replace 语义仍重置该库学习状态（显式操作已先 preBackup）
      await db.states.where('deckId').equals(deck.id).delete()
    }
    const nextDeck: Deck = {
      ...deck,
      createdAt: existingDeck?.createdAt ?? deck.createdAt ?? now,
      updatedAt: now,
    }
    await db.decks.put(nextDeck)
    if (strategy !== 'replace') await bulkPutChunked(db.words, words)
    // 没有任何选中词库时，自动选中导入的词库
    const selected = await db.settings.get('data.selectedDeckId')
    const selectedDeck = selected ? await db.decks.get(selected.value as string) : undefined
    if (!selectedDeck) {
      await db.settings.put({ key: 'data.selectedDeckId', value: deck.id, updatedAt: now })
    }
    // 默认词库全局唯一（QA-01：导入文件不能造出第二个 isDefault）
    await ensureSingleDefaultDeck(existingDefaultId)
  })

  const report = makeReport(
    'deck',
    issues,
    { decks: 1, words: words.length, skipped: issues.filter((i) => i.code === 'W_SKIPPED').length },
    Date.now() - startedAt,
  )
  await writeLastImport(report)
  return report
}

// ============ 导入：CSV ============

/** 导入 CSV 词单（新建词库；同 headword 多行合并） */
export async function importCsv(input: string | File, deckName?: string): Promise<ImportReport> {
  const startedAt = Date.now()
  const db = getDb()
  const now = Date.now()
  const text = await readInput(input)
  const parsed = parseCsv(text)
  const converted = csvToWordInputs(parsed)
  const issues = converted.issues
  if (issues.some((issue) => issue.level === 'error') || converted.words.length === 0) {
    const report = makeReport('csv', issues, { skipped: parsed.rows.length }, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }

  const { buildWord } = await import('./word-factory')
  const existingDecks = await db.decks.toArray()
  const name = uniqueDeckName(
    (deckName ?? '导入的词库').trim() || '导入的词库',
    new Set(existingDecks.map((deck) => deck.name)),
  )
  let deckId = newDeckId(name, now)
  while (await db.decks.get(deckId)) deckId = `${deckId}-${Math.random().toString(36).slice(2, 5)}`
  const words: Word[] = converted.words.map((raw: RawWordInput, index) =>
    buildWord(raw, deckId, { order: index + 1, createdAt: now }),
  )
  const deck: Deck = {
    id: deckId,
    name,
    source: 'imported',
    wordCount: words.length,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  // 0.14 B4：sqlite 内容写源——先写 content_kv，成功后才写 IDB cache；失败返回结构化 report，不回写 IDB
  if ((await getContentWriteSource()) === 'sqlite') {
    const rows = [contentRowOfDeck(deck), ...words.map((word) => contentRowOfWord(word, now))]
    const saved = await saveContentEntitiesChunked(rows)
    if (!saved.ok) {
      const report = makeReport(
        'csv',
        [...issues, makeIssue('error', 'E_IO', `SQLite 内容写入失败（已写 ${saved.written}/${rows.length} 条，失败批未回写 IDB）：${saved.error ?? '未知错误'}`, { path: 'data' })],
        { decks: saved.written > 0 ? 1 : 0, words: Math.max(0, saved.written - 1), skipped: parsed.rows.length - converted.words.length },
        Date.now() - startedAt,
      )
      await writeLastImport(report)
      return report
    }
    const selected = await db.settings.get('data.selectedDeckId')
    if (!selected) {
      await db.settings.put({ key: 'data.selectedDeckId', value: deckId, updatedAt: now })
    }
    const report = makeReport(
      'csv',
      issues,
      { decks: 1, words: words.length, skipped: parsed.rows.length - converted.words.length },
      Date.now() - startedAt,
    )
    await writeLastImport(report)
    return report
  }
  await db.transaction('rw', db.decks, db.words, db.settings, async () => {
    await db.decks.put(deck as never)
    await bulkPutChunked(db.words, words)
    const selected = await db.settings.get('data.selectedDeckId')
    if (!selected) {
      await db.settings.put({ key: 'data.selectedDeckId', value: deckId, updatedAt: now })
    }
  })
  const report = makeReport(
    'csv',
    issues,
    { decks: 1, words: words.length, skipped: parsed.rows.length - converted.words.length },
    Date.now() - startedAt,
  )
  await writeLastImport(report)
  return report
}

// ============ 导入：可迁移包 ============

/** 合并两条学习状态（§6.2 merge：lastReviewedAt 较新者为准，clicks/encounters 取 max） */
function mergeStatMap(
  a: Record<string, { clicks: number; encounters: number }> | undefined,
  b: Record<string, { clicks: number; encounters: number }> | undefined,
): Record<string, { clicks: number; encounters: number }> {
  const out: Record<string, { clicks: number; encounters: number }> = { ...(a ?? {}) }
  for (const [key, stat] of Object.entries(b ?? {})) {
    const old = out[key]
    out[key] = old
      ? { clicks: Math.max(old.clicks, stat.clicks), encounters: Math.max(old.encounters, stat.encounters) }
      : { ...stat }
  }
  return out
}

function mergeState(local: WordState, imported: WordState): WordState {
  const localAt = local.lastReviewedAt ?? -Infinity
  const importedAt = imported.lastReviewedAt ?? -Infinity
  const base = importedAt > localAt ? imported : local
  const other = base === imported ? local : imported
  const meaningStats: WordState['meaningStats'] = { ...other.meaningStats }
  for (const [meaningId, stat] of Object.entries(base.meaningStats)) {
    const old = meaningStats[meaningId]
    meaningStats[meaningId] = old
      ? {
          clicks: Math.max(old.clicks, stat.clicks),
          encounters: Math.max(old.encounters, stat.encounters),
        }
      : { ...stat }
  }
  const coreSenseStats = mergeStatMap(local.coreSenseStats, imported.coreSenseStats)
  return {
    ...base,
    meaningStats,
    ...(Object.keys(coreSenseStats).length > 0 ? { coreSenseStats } : {}),
    updatedAt: Math.max(local.updatedAt ?? 0, imported.updatedAt ?? 0),
  }
}

/** 导入可迁移包（replace / merge / keepNewer） */
export function importMigration(
  input: string | File,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  if (getLearningWriteSource() === 'sqlite') {
    // 0.11 新架构：IDB 暂存导入 → 清 SQLite → migrate/rebuild/counts 校验；失败回滚 SQLite prebackup。
    if (opts.sqliteStageImpl) return importMigrationSqliteStaging(input, opts)
    return importMigrationSqliteStaging(input, opts)
  }
  assertIdbMutationAllowed('导入迁移包')
  return opts.skipWriteLock ? importMigrationInner(input, opts) : withDataWriteLock(() => importMigrationInner(input, opts))
}

/**
 * A3：sqlite 模式「暂存 IDB→重建 SQLite」导入：
 * 锁内 preBackup + readonly 阻止用户写 → 现有 IDB 导入 → 清 SQLite → migrate→rebuild→校验；
 * 失败恢复 SQLite prebackup、写源 idb，绝不留双源。
 */


/**
 * 0.16 P0-1：replace 导入后断言 facts 与包内“精确相等”，任何残留或多写都视为失败（触发回滚）。
 * - states：包内 states（限包内 deck）条数 === IDB/SQLite 实际条数；
 * - plans：包内今日 plan 条数 === IDB/SQLite 实际条数。
 * SQLite 侧用 staging 已取的 health counts（前面已与 IDB 逐项比对过），不额外查询，避免测试注入/超时放大失败面。
 */
async function assertReplaceFactsExact(
  input: string | File,
  counts: { states: number; plans: number },
): Promise<void> {
  const text = typeof input === 'string' ? input : await input.text()
  const raw = JSON.parse(text) as {
    data?: {
      plans?: Array<Record<string, unknown>>
      states?: Array<Record<string, unknown>>
      decks?: Array<Record<string, unknown>>
    }
  }
  const today = localDateKey(Date.now())
  const filePlans = (raw.data?.plans ?? []).filter((plan) => plan.date === today)
  const fileDeckIds = new Set((raw.data?.decks ?? []).map((deck) => String(deck.id ?? '')))
  const fileStateWordIds = new Set(
    (raw.data?.states ?? [])
      .filter((state) => fileDeckIds.has(String(state.deckId ?? '')))
      .map((state) => String(state.wordId ?? '')),
  )
  const db = getDb()
  let idbStatesInScope = 0
  for (const deckId of fileDeckIds) idbStatesInScope += await db.states.where('deckId').equals(deckId).count()
  if (idbStatesInScope !== fileStateWordIds.size) {
    throw new Error(
      `替换导入后 states 未精确对齐：包内 ${fileStateWordIds.size} 条，本机残留/缺 ${idbStatesInScope} 条（同一 deck 范围）`,
    )
  }
  const idbPlans = await db.plans.count()
  if (idbPlans !== filePlans.length) {
    throw new Error(`替换导入后 plans 未精确对齐：包内今日 ${filePlans.length} 条，本机 ${idbPlans} 条`)
  }
  if (Number(counts.states) !== fileStateWordIds.size) {
    throw new Error(`替换导入后 SQLite states 未精确对齐：包内 ${fileStateWordIds.size} 条，SQLite ${Number(counts.states)} 条`)
  }
  if (Number(counts.plans) !== filePlans.length) {
    throw new Error(`替换导入后 SQLite plans 未精确对齐：包内今日 ${filePlans.length} 条，SQLite ${Number(counts.plans)} 条`)
  }
}

/**
 * 0.16 P1-1：staging 导入后只对 **replace** 校验“包内今日 plan 已落盘”，并回读 SQLite 确认。
 * merge/keepNewer 必须保留本机计划（`importMigrationInner` 也已如此），不得在此覆盖。
 * 这里只做校验与补写（IDB 在 clearFacts 后可能被 cache 重建覆盖），不做任何 strategy 越权写入。
 */
async function verifyImportedPlansPersisted(input: string | File, strategy: 'replace' | 'merge' | 'keepNewer'): Promise<void> {
  if (strategy !== 'replace') return
  const text = typeof input === 'string' ? input : await input.text()
  const raw = JSON.parse(text) as { data?: { plans?: Array<Record<string, unknown>> } }
  const plans = (raw.data?.plans ?? []).filter((item) => typeof item.id === 'string' && typeof item.date === 'string')
  if (plans.length === 0) return
  const db = getDb()
  const today = localDateKey(Date.now())
  const expected = plans.filter((plan) => plan.date === today)
  for (const plan of expected) {
    // 跨天 plan 不恢复（与既有产品语义一致），只校验今日
    const back = await sqliteQuery({ table: 'plans', where: { id: String(plan.id) }, limit: 1 }, 5_000)
    const rows = (back.rows as Array<Record<string, unknown>> | undefined) ?? []
    if (rows.length !== 1) {
      // SQLite 侧缺失：先补写（cache 重建只重建 IDB，不会补 SQLite），再回读确认
      const tx = await sqliteTx([{ op: 'upsert', table: 'plans', row: migrationPlanRow(plan) }])
      if (tx.ok === false) throw new Error(tx.message ?? 'plan 写回 SQLite 失败')
    }
    if ((await db.plans.get(String(plan.id))) == null) await db.plans.put(plan as never)
    const recheck = await sqliteQuery({ table: 'plans', where: { id: String(plan.id) }, limit: 1 }, 5_000)
    const recheckRows = (recheck.rows as Array<Record<string, unknown>> | undefined) ?? []
    if (recheckRows.length !== 1 || (await db.plans.get(String(plan.id))) == null) {
      throw new Error(`导入后 plan 校验失败：${String(plan.id)}`)
    }
  }
}

/**
 * 0.16 P0-2：staging 里 SQLite `settings` 必须收敛成「IDB 将写入的键集合 ∪ 设备本地白名单」。
 *
 * 根因：`clearFacts` 只清 states/plans/review_logs，SQLite 已有的 settings 会残留；
 * 而 `migrateIdbToSqlite` 的 counts 校验是「IDB 行数 === SQLite 行数」，多一个包外键就整体失败
 * （失败时 IDB 已被改写、写源又被切回 idb，等于“导入失败但数据换了一半”）。
 *
 * 处理：删除 SQLite 中“不属于 IDB 即将写入集合、也不在设备本地白名单”的键。
 * 设备本地键必须保留（它们不进迁移包，见 importMigrationInner 的 deviceLocalKeys）。
 */
const DEVICE_LOCAL_SETTING_KEYS = ['data.maimemoToken', 'ai.apiKey', 'data.autoBackupEnabled', 'data.contentWriteSource'] as const

async function convergeSqliteSettingsToIdb(): Promise<{ removed: number; keptLocal: number; kept: number }> {
  if (!isSqliteAvailable()) return { removed: 0, keptLocal: 0, kept: 0 }
  const db = getDb()
  const idbRows = await db.settings.toArray()
  const idbKeys = new Set(idbRows.map((row) => String(row.key)))
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; offset < 1_000_000; offset += 500) {
    const response = await sqliteQuery({ table: 'settings', limit: 500, offset, orderBy: 'key', direction: 'asc' }, 5_000)
    if (response.ok === false) throw new Error(`读取 SQLite settings 失败：${response.message ?? '未知错误'}`)
    const page = (response.rows as Array<Record<string, unknown>> | undefined) ?? []
    rows.push(...page)
    if (page.length < 500) break
  }
  const deviceLocal = new Set<string>(DEVICE_LOCAL_SETTING_KEYS)
  // 设备本地键：SQLite 有、IDB 没有时**补写进 IDB**（token/apiKey 不进迁移包，绝不能因导入丢失），
  // 而不是留在 SQLite 造成 counts 口径不一致。
  const backfill: Array<{ key: string; value: unknown; updatedAt: number }> = []
  for (const row of rows) {
    const key = String(row.key ?? '')
    if (!key || idbKeys.has(key) || !deviceLocal.has(key)) continue
    const { mapSqliteSettingRow } = await import('./sqlite-read')
    const mapped = mapSqliteSettingRow(row)
    backfill.push({ key, value: mapped.value, updatedAt: mapped.updatedAt })
    idbKeys.add(key)
  }
  if (backfill.length > 0) await db.settings.bulkPut(backfill as never)
  const stale = rows.map((row) => String(row.key ?? '')).filter((key) => key.length > 0 && !idbKeys.has(key))
  if (stale.length > 0) {
    const tx = await sqliteTx(stale.map((key) => ({ op: 'delete', table: 'settings', where: { key } })))
    if (tx.ok === false) throw new Error(`收敛 SQLite settings 失败：${tx.message ?? '未知错误'}`)
  }
  return { removed: stale.length, keptLocal: backfill.length, kept: rows.length - stale.length }
}

/**
 * 0.16 P0-3：staging 失败时收敛 content 写源，避免「learning=idb、content=sqlite」双源分叉。
 * - 恢复到导入前的 content 写源；native v15 场景用 emergency override 才能真的回 idb；
 * - 清 `contentMigrationState`（半迁移状态不可信）；
 * - content_kv 有 live 行时标 `contentKvStale`，供下次 v15/切源先处理（不静默复活旧内容）；
 * - 仅在内容写源确为 sqlite 且确实写过内容时才需要，避免动坏 web 场景。
 */
async function convergeContentSourceAfterStagingFailure(snapshot: {
  contentSourceBefore: string
  contentMigrationStateBefore: unknown
  contentKvStaleBefore: unknown
}): Promise<{ ok: boolean; source?: string; error?: string }> {
  try {
    const { getContentWriteSource, persistContentWriteSource } = await import('./content-write-source')
    const { readContentCounts } = await import('./content-store')
    const { CONTENT_KV_STALE_KEY } = await import('./content-store')
    const { CONTENT_MIGRATION_STATE_KEY } = await import('./content-migration-plan')
    const db = getDb()
    // 只把“导入期间被改成 sqlite”的场景拉回导入前；导入前就是 sqlite 时保持不动（v15 done 后固定 sqlite）
    const current = await getContentWriteSource()
    if (snapshot.contentSourceBefore !== 'sqlite' && current === 'sqlite') {
      const { isNativeContentSqliteRuntime } = await import('./content-write-source')
      if (isNativeContentSqliteRuntime()) {
        const { setContentSourceEmergencyIdb } = await import('./content-write-source')
        await setContentSourceEmergencyIdb('import-failed-rollback')
      }
      await persistContentWriteSource('idb').catch(() => undefined)
    }
    // 迁移状态不可信：只有“已完成/就绪”才恢复；running/failed/缺失一律清除，
    // 由 reconcileInterruptedContentMigration / 下次 v15 重新判定，绝不能留下假的 running。
    const beforeStatus = (snapshot.contentMigrationStateBefore as { status?: string } | null)?.status
    if (beforeStatus === 'done' || beforeStatus === 'ready') {
      await db.meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: snapshot.contentMigrationStateBefore, updatedAt: Date.now() }).catch(() => undefined)
    } else {
      await db.meta.delete(CONTENT_MIGRATION_STATE_KEY).catch(() => undefined)
    }
    // content_kv 已写入导入内容 → 标 stale，禁止在未清理前按 kv 备份/切源
    if (snapshot.contentKvStaleBefore == null) {
      const counts = await readContentCounts().catch(() => null)
      if (counts && counts.total > 0 && counts.deleted < counts.total) {
        await db.meta
          .put({ key: CONTENT_KV_STALE_KEY, value: { at: Date.now(), total: counts.total, deleted: counts.deleted, reason: 'import-staging-failed' }, updatedAt: Date.now() })
          .catch(() => undefined)
      }
    }
    const after = await getContentWriteSource().catch(() => 'idb')
    return { ok: true, source: after }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function importMigrationSqliteStagingInner(input: string | File, opts: ImportOptions = {}): Promise<ImportReport> {
    const stageTiming: Record<string, number> = {}
    let stageStart = Date.now()
    const mark = (name: string, message: string) => {
      stageTiming[name] = Date.now() - stageStart
      stageStart = Date.now()
      try { opts.onProgress?.({ phase: 'apply', message }) } catch { /* ignore */ }
    }
    opts.onProgress?.({ phase: 'apply', message: '准备导入（预计 32MB 包可能 3–5 分钟，请勿退出）' })
    if (!opts.preBackup) throw new Error('SQLite 模式导入前必须先完整备份（preBackup 未提供）')
    const pre = await opts.preBackup()
    mark('preBackup', '应用级备份完成')
    if (pre && pre.ok === false) throw new Error(`预备份失败，已拒绝导入：${pre.error ?? '未知错误'}`)
    const stage = opts.sqliteStageImpl ?? {}
    const createBackup = stage.createBackup ?? createSqliteFactsBackup
    const restoreBackup = stage.restoreBackup ?? restoreSqliteFactsBackup
    const clearFacts = stage.clearFacts ?? (() => clearSqliteFactsTables(['states', 'plans', 'review_logs']))
    const migrate = stage.migrate ?? migrateIdbToSqlite
    const rebuildCache = stage.rebuildCache ?? rebuildIdbCacheFromSqlite
    const sqliteBackup = await createBackup()
    mark('sqliteBackup', 'SQLite 快照完成')
    if (!sqliteBackup.ok || !sqliteBackup.manifest) throw new Error(`SQLite 备份失败：${sqliteBackup.error ?? '未知错误'}`)
    const writeStage = (phase: string) => getDb().meta.put({ key: 'import.sqlite.stageNow', value: { phase, at: Date.now() }, updatedAt: Date.now() }).catch(() => undefined)
    await writeStage('backup-done')
    // 0.16 P0-3：记录导入前 content 写源/迁移状态/stale，失败时据此收敛（避免 learning=idb、content=sqlite 分叉）
    const contentSourceBefore = await (await import('./content-write-source')).getContentWriteSource().catch(() => 'idb')
    const { CONTENT_KV_STALE_KEY: contentKvStaleKey } = await import('./content-store')
    const { CONTENT_MIGRATION_STATE_KEY: contentMigrationStateKey } = await import('./content-migration-plan')
    const contentMigrationStateBefore = (await getDb().meta.get(contentMigrationStateKey))?.value ?? null
    const contentKvStaleBefore = (await getDb().meta.get(contentKvStaleKey))?.value ?? null
    await persistLearningWriteSource('readonly')
    try {
      await writeStage('readonly')
      const report = await importMigrationInner(input, { ...opts, skipWriteLock: true })
      mark('idbImport', 'IDB 暂存导入完成')
      if (!report.ok) {
        const first = report.issues.find((issue) => issue.level === 'error')
        throw new Error(first ? `${first.code}: ${first.message}` : '导入报告失败')
      }
      await writeStage('clear')
      await clearFacts()
      mark('clearSqlite', 'SQLite 清空完成')
      await writeStage('migrate')
      // 根因：staging 清 facts 后 migration_state 仍为 done，migrate 会直接 skipped（plans 不写回）。
      // 正式迁移前清掉 legacy-idb done 标记，让 migrate 重新执行。
      if (stage.resetMigrationState) await stage.resetMigrationState()
      else if (isSqliteAvailable()) {
        const resetMigration = await sqliteTx([{ op: 'delete', table: 'migration_state', where: { step: SQLITE_MIGRATION_STEP } }])
        if (resetMigration.ok === false) throw new Error(resetMigration.message ?? '重置迁移状态失败')
      }
      // 0.16 P0-2：settings 不在 clearFacts 范围；migrate 的 counts 校验按「IDB 行数」比较，
      // 设备上任何包外键都会让整个导入失败（且此时 IDB 已被改写）。迁移前把 SQLite settings
      // 收敛为「IDB 将写入的键 ∪ 设备本地白名单」，使计数口径一致。
      const settingsConverge = await convergeSqliteSettingsToIdb().catch((error: unknown) => ({ removed: 0, keptLocal: 0, kept: 0, error: error instanceof Error ? error.message : String(error) }))
      if ('error' in settingsConverge && settingsConverge.error) throw new Error(`导入前收敛 SQLite settings 失败：${settingsConverge.error}`)
      const migrated = await migrate({ dryRun: false, unsafe: true, skipWriteLock: true, force: true })
      mark('migrate', 'SQLite 写入完成')
      if (!migrated.ok) throw new Error(`导入后 SQLite 重建失败：${migrated.error ?? '未知'}`)
      await writeStage('rebuild')
      const rebuilt = await rebuildCache({ unsafe: true, skipWriteLock: true })
      mark('rebuild', 'cache 重建完成')
      if (!rebuilt.ok) throw new Error(`导入后 cache 重建失败：${rebuilt.error ?? rebuilt.conflict ?? '未知'}`)
      const health = stage.health ? await stage.health() : await (await import('./native-sqlite')).sqliteHealth(30_000)
      const counts = (health as unknown as { counts?: Record<string, number> }).counts ?? {}
      const db = getDb()
      const [states, plans, settings, logs] = await Promise.all([db.states.count(), db.plans.count(), db.settings.count(), db.reviewLogs.count()])
      if (Number(counts.states ?? -1) !== states || Number(counts.plans ?? -1) !== plans || Number(counts.settings ?? -1) !== settings || Number(counts.review_logs ?? -1) !== logs) {
        throw new Error('导入后 SQLite/IDB counts 不一致')
      }
      await writeStage('verify')
      // 0.16 P0-1：replace 断言 states/plans 与包内精确相等（SQLite 侧也校验，防止 migrate skipped 后空转）
      if ((opts.strategy ?? 'replace') === 'replace') {
        await assertReplaceFactsExact(input, { states: Number(counts.states ?? -1), plans: Number(counts.plans ?? -1) })
      }
      await verifyImportedPlansPersisted(input, opts.strategy ?? 'replace')
      await persistLearningWriteSource('sqlite')
      const { persistSettingsWriteMode } = await import('./settings.repo')
      await persistSettingsWriteMode('sqlite').catch(() => undefined)
      // 0.15 B：native sqlite 保持 sqlite；web/未迁移仍 idb（不绕过门禁）
      await applyContentSourceAfterImport()
      mark('done', '导入完成')
      const { deleteSafetySnapshot } = await import('./sqlite-backup')
      await deleteSafetySnapshot(sqliteBackup.manifest).catch(() => undefined)
      await getDb().meta.delete('import.sqlite.stageNow').catch(() => undefined)
      try { await getDb().meta.put({ key: 'import.sqlite.stageTiming', value: { at: Date.now(), stageTiming }, updatedAt: Date.now() }) } catch { /* ignore */ }
      return report
    } catch (error) {
      // 恢复导入前 SQLite；IDB 保留导入结果但写源回 idb，避免双源。
      // 0.16 P0-3：失败必须收敛“三件套”→ SQLite 快照 + content 写源/v15 状态 + cache 重建（下方 finishStagingFailure）。
      let restoreOk = false
      let restoreError: string | undefined
      try {
        const file = sqliteBackup.manifest
        const restored = await restoreBackup(
          { ...(file.path ? { path: file.path } : {}), manifest: file },
          { preBackup: async () => ({ ok: true }), skipWriteLock: true, allowEmptySafety: true },
        )
        restoreOk = restored.ok === true
        if (!restoreOk) restoreError = restored.error ?? '未知错误'
      } catch (restoreFailure) {
        restoreError = restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)
      }
      await persistLearningWriteSource('idb').catch(() => undefined)
      const { persistSettingsWriteMode } = await import('./settings.repo')
      await persistSettingsWriteMode('idb').catch(() => undefined)
      // 0.16 P0-3：content 写源/迁移状态收敛（否则 learning=idb、content=sqlite 长期分叉）
      const contentConverge = await convergeContentSourceAfterStagingFailure({
        contentSourceBefore,
        contentMigrationStateBefore,
        contentKvStaleBefore,
      })
      // 0.16 P1-2：失败必须覆盖 import:last，否则设置页仍显示“上次导入成功”
      await writeLastImport(
        makeReport(
          'migration',
          [
            makeIssue(
              'error',
              'E_IO',
              `导入失败（SQLite 重建/校验阶段）：${error instanceof Error ? error.message : String(error)}${
                restoreOk ? '；已回滚到导入前 SQLite 备份' : `；SQLite 回滚失败：${restoreError ?? '未知'}`
              }`,
              { path: 'data' },
            ),
          ],
          {},
          stageTiming.migrate ?? 0,
        ),
      ).catch(() => undefined)
      const diag = await collectStagingFailureDiag({ error, restoreOk, restoreError, stageTiming }).catch(() => null)
      try {
        await getDb().meta.put({
          key: 'import.sqlite.stageDiag',
          value: {
            at: Date.now(),
            stageTiming,
            restoreOk,
            ...(restoreError ? { restoreError } : {}),
            error: error instanceof Error ? error.message : String(error),
            contentSourceBefore,
            contentConverge,
            ...(diag ? { sources: diag } : {}),
          },
          updatedAt: Date.now(),
        })
      } catch {
        /* ignore */
      }
      throw error
    }
}

/**
 * 0.16 P0-3：staging 失败后的三源计数诊断（不改变数据，只用于判断是否已分叉）。
 * - sqlite：SQLite facts（已回滚后应为导入前）
 * - idb：IDB cache facts（导入后被改写，可能≠SQLite）
 * - content：content_kv 计数 + 内容写源
 */
async function collectStagingFailureDiag(args: {
  error: unknown
  restoreOk: boolean
  restoreError?: string
  stageTiming: Record<string, number>
}): Promise<Record<string, unknown>> {
  const db = getDb()
  const [idbStates, idbPlans, idbSettings, idbLogs] = await Promise.all([
    db.states.count(),
    db.plans.count(),
    db.settings.count(),
    db.reviewLogs.count(),
  ])
  let sqlite: Record<string, number> | null = null
  try {
    const health = await (await import('./native-sqlite')).sqliteHealth(30_000)
    const counts = (health as unknown as { counts?: Record<string, number> }).counts ?? {}
    sqlite = {
      states: Number(counts.states ?? -1),
      plans: Number(counts.plans ?? -1),
      settings: Number(counts.settings ?? -1),
      reviewLogs: Number(counts.review_logs ?? -1),
    }
  } catch {
    sqlite = null
  }
  let content: Record<string, unknown> | null = null
  try {
    const { readContentCounts } = await import('./content-store')
    const { getContentWriteSource } = await import('./content-write-source')
    const counts = await readContentCounts()
    content = { source: await getContentWriteSource(), total: counts.total, deleted: counts.deleted, revision: counts.revision }
  } catch {
    content = null
  }
  return {
    idb: { states: idbStates, plans: idbPlans, settings: idbSettings, reviewLogs: idbLogs },
    sqlite,
    content,
    restoreOk: args.restoreOk,
    ...(args.restoreError ? { restoreError: args.restoreError } : {}),
    learningWriteSource: getLearningWriteSource(),
  }
}

function importMigrationSqliteStaging(input: string | File, opts: ImportOptions = {}): Promise<ImportReport> {
  return opts.skipWriteLock ? importMigrationSqliteStagingInner(input, opts) : withDataWriteLock(() => importMigrationSqliteStagingInner(input, { ...opts, skipWriteLock: true }))
}

/**
 * A3 facts-only：sqlite 模式只写 states/plans/settings/reviewLogs 到 SQLite；
 * words 不写 IDB（内置词库已有），仅缺失的自定义 deck 才导入 words。
 */
async function writeImportStageNow(phase: string, extra: Record<string, unknown> = {}): Promise<void> {
  try { await getDb().meta.put({ key: 'import.sqlite.stageNow', value: { phase, at: Date.now(), ...extra }, updatedAt: Date.now() }) } catch { /* ignore */ }
}

async function clearImportStageNow(): Promise<void> {
  await getDb().meta.delete('import.sqlite.stageNow').catch(() => undefined)
}

async function importMigrationSqliteInner(input: string | File, opts: ImportOptions = {}): Promise<ImportReport> {
    const stageTiming: Record<string, number> = {}
    let stageStart = Date.now()
    const mark = (name: string, message: string) => {
      stageTiming[name] = Date.now() - stageStart
      stageStart = Date.now()
      try { opts.onProgress?.({ phase: 'apply', message: `${message}（${Math.round(stageTiming[name]!)}ms）` }) } catch { /* ignore */ }
    }
    const startedAt = Date.now()
    const strategy = opts.strategy ?? 'replace'
    const returnReport = async (report: ImportReport): Promise<ImportReport> => { await writeLastImport(report); return report }
    await writeImportStageNow('prepare')
    opts.onProgress?.({ phase: 'apply', message: 'facts-only 导入：只写学习事实，不写 12230 words' })
    if (!opts.preBackup) throw new Error('SQLite 模式导入前必须先备份（preBackup 未提供）')
    const pre = await opts.preBackup()
    if (pre && pre.ok === false) throw new Error(`预备份失败，已拒绝导入：${pre.error ?? '未知错误'}`)
    await writeImportStageNow('parse')
    const text = await readInput(input)
    const json = await parseJsonText(text)
    if (!json.ok) return returnReport(makeReport('migration', json.issues, {}, Date.now() - startedAt))
    const raw = json.value as Record<string, unknown>
    if (raw.format !== 'momo-migration') return returnReport(makeReport('migration', [makeIssue('error', 'E_FORMAT', '不是可迁移包', { path: 'format' })], {}, Date.now() - startedAt))
    if (raw.formatVersion !== 1 || raw.dataVersion !== 1) return returnReport(makeReport('migration', [makeIssue('error', 'E_VERSION', '可迁移包版本不支持', { path: 'formatVersion' })], {}, Date.now() - startedAt))
    mark('parseJson', 'JSON.parse 完成')
    await writeImportStageNow('checksum')
    const checksumPayload = migrationChecksumPayload({ format: String(raw.format ?? ''), formatVersion: Number(raw.formatVersion ?? 0), dataVersion: Number(raw.dataVersion ?? 0), data: raw.data })
    const checksum = await (await import('./checksum')).verifyChecksum(checksumPayload, typeof raw.checksum === 'string' ? raw.checksum : '')
    if (!checksum.ok && !opts.force) return returnReport(makeReport('migration', [makeIssue('error', 'E_CHECKSUM', '校验和不匹配，文件可能被修改过', { path: 'checksum' })], {}, Date.now() - startedAt))
    mark('checksum', '校验和完成')
    // facts-only：绕开 migrationFileSchema/zod 对 12230 words 的全量校验；只提取事实与 deck 元数据。
    const data = (raw.data ?? {}) as Record<string, unknown>
    const arr = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value as Array<Record<string, unknown>> : [])
    const file = {
      decks: arr(data.decks),
      words: arr(data.words),
      states: arr(data.states),
      reviewLogs: arr(data.reviewLogs),
      settings: arr(data.settings),
      plans: arr(data.plans),
      issues: [] as ImportIssue[],
    } as unknown as {
      decks: Array<{ id: string } & Record<string, unknown>>
      words: Array<{ id: string; deckId: string } & Record<string, unknown>>
      states: Array<{ wordId: string; deckId: string; updatedAt: number } & Record<string, unknown>>
      reviewLogs: Array<{ wordId: string; deckId: string } & Record<string, unknown>>
      settings: Array<{ key: string; updatedAt: number; value: unknown } & Record<string, unknown>>
      plans: Array<{ id: string; deckId: string } & Record<string, unknown>>
      issues: ImportIssue[]
    }
    mark('extract', `事实提取完成（facts ${file.states.length + file.reviewLogs.length + file.settings.length + file.plans.length}）`)
    await writeImportStageNow('idbFacts')
    const sqliteBackup = await createSafetySnapshot()
    if (!sqliteBackup.ok || !sqliteBackup.manifest) throw new Error(`SQLite 备份失败：${sqliteBackup.error ?? '未知错误'}`)
    await writeImportStageNow('importing', { backupName: sqliteBackup.manifest.name, backupPath: sqliteBackup.manifest.path })
    await persistLearningWriteSource('readonly')
    try {
      const db = getDb()
      const issues: ImportIssue[] = [...file.issues]
      // 1) 自定义 deck：仅 deck 不存在时导入 deck+words（分批）；内置词库不写 words。
      const contentSqlite = (await getContentWriteSource()) === 'sqlite'
      const importedDecks = new Set<string>()
      for (const deck of file.decks) {
        const existing = await db.decks.get(deck.id)
        if (existing) continue
        importedDecks.add(deck.id)
        const words = file.words.filter((word) => word.deckId === deck.id)
        if (contentSqlite && !isBuiltinDeckFile(deck as unknown as Deck)) {
          // 0.14 QA P0：自定义 deck/word 先进 content_kv（≤500/批），失败不写 IDB
          const rows: ContentEntityRow[] = [
            { key: `deck:${deck.id}`, kind: 'deck', json: JSON.stringify(deck), updatedAt: Date.now() },
            ...words.map((word) => ({
              key: `word:${String(word.id)}`,
              kind: 'word' as const,
              json: JSON.stringify(word),
              updatedAt: Number((word as { createdAt?: number }).createdAt) || Date.now(),
            })),
          ]
          const saved = await saveContentEntitiesChunked(rows)
          if (!saved.ok) {
            throw new ContentWriteError(`自定义词库内容写入 content_kv 失败：${saved.error ?? '未知错误'}`, 'CONTENT_SQLITE_WRITE_FAILED')
          }
        } else {
          await db.transaction('rw', [db.decks, db.words, db.meta], async () => {
            await db.decks.put(deck as never)
            for (let i = 0; i < words.length; i += 500) await db.words.bulkPut(words.slice(i, i + 500) as never)
          })
        }
      }
      // 2) 内置 deck 缺词先用内置词表补（单 deck）；失败只跳过缺词，不整单失败。
      const referencedDeckIds = new Set<string>()
      for (const state of file.states) referencedDeckIds.add(state.deckId)
      for (const log of file.reviewLogs) referencedDeckIds.add(log.deckId)
      for (const plan of file.plans) referencedDeckIds.add(plan.deckId)
      for (const deckId of referencedDeckIds) {
        try { await ensureBuiltinDeckWords(deckId) } catch { /* custom/missing deck */ }
      }
      // 3) 过滤缺词事实（不整单失败，报告 skipped）
      const wordIds = new Set((await db.words.toArray()).map((word) => word.id))
      const states = file.states.filter((state) => wordIds.has(state.wordId))
      const logs = file.reviewLogs.filter((log) => wordIds.has(log.wordId))
      const skippedStates = file.states.length - states.length
      const skippedLogs = file.reviewLogs.length - logs.length
      if (skippedStates > 0) issues.push(makeIssue('warning', 'W_SKIPPED', `${skippedStates} 条学习状态缺词，已跳过`, { path: 'data.states' }))
      if (skippedLogs > 0) issues.push(makeIssue('warning', 'W_SKIPPED', `${skippedLogs} 条复习日志缺词，已跳过`, { path: 'data.reviewLogs' }))
      mark('prepare', `事实准备完成（states ${states.length} / logs ${logs.length} / custom decks ${importedDecks.size}）`)

      // 4) merge/keepNewer：本地较新时保留本地；replace 先清 states/plans/review_logs（保留 settings/token）。
      const readAll = async (table: string, key: string): Promise<Array<Record<string, unknown>>> => {
        const out: Array<Record<string, unknown>> = []
        for (let offset = 0; offset < 1_000_000; offset += 500) {
          const res = await sqliteQuery({ table, limit: 500, offset, orderBy: key, direction: 'asc' }, 5_000)
          const rows = (res.rows as Array<Record<string, unknown>> | undefined) ?? []
          out.push(...rows)
          if (rows.length < 500) break
        }
        return out
      }
      if (strategy === 'replace') {
        await writeImportStageNow('clear')
        await clearSqliteFactsTables(['states', 'plans', 'review_logs'])
      }
      const localStateUpdated = new Map((await readAll('states', 'word_id')).map((row) => [String(row.word_id), Number(row.updated_at ?? 0)]))
      const localSettingUpdated = new Map((await readAll('settings', 'key')).map((row) => [String(row.key), Number(row.updated_at ?? 0)]))
      const ops: unknown[] = []
      if (strategy === 'merge' || strategy === 'keepNewer') {
        for (const state of states) {
          const local = localStateUpdated.get(state.wordId)
          if (local != null && local >= state.updatedAt) continue
          ops.push({ op: 'upsert', table: 'states', row: migrationStateRow(state as unknown as Record<string, unknown>) })
        }
      } else {
        for (const state of states) ops.push({ op: 'upsert', table: 'states', row: migrationStateRow(state as unknown as Record<string, unknown>) })
      }
      for (const plan of file.plans) ops.push({ op: 'upsert', table: 'plans', row: migrationPlanRow(plan as unknown as Record<string, unknown>) })
      for (const log of logs) ops.push({ op: 'upsert', table: 'review_logs', row: migrationLogRow(log as unknown as Record<string, unknown>) })
      for (const setting of file.settings) {
        // S2：facts-only 恢复同样不得写回 sqlite 内容写源（设备本地键/迁移门禁）
        if (setting.key === 'data.maimemoToken' || setting.key === 'data.contentWriteSource') continue
        const local = localSettingUpdated.get(setting.key)
        if ((strategy === 'merge' || strategy === 'keepNewer') && local != null && local >= setting.updatedAt) continue
        ops.push({ op: 'upsert', table: 'settings', row: migrationSettingRow(setting as unknown as Record<string, unknown>) })
      }
      mark('build-ops', `写入操作 ${ops.length} 条（states ${states.length}/plans ${file.plans.length}/logs ${logs.length}）`)
      await writeImportStageNow('migrate')
      for (let i = 0; i < ops.length; i += 400) {
        if (opts.shouldAbort?.()) throw new Error('导入已取消')
        const tx = await sqliteTx(ops.slice(i, i + 400))
        if (tx.ok === false) throw new Error(tx.message ?? 'facts-only SQLite 写入失败')
      }
      mark('idbFacts', `facts-only SQLite 写入完成（${ops.length} ops）`)
      const rebuilt = await runWithTimeout(rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true, onProgress: (stage) => { void writeImportStageNow(`rebuild:${stage}`) } }), 20_000, '导入后 cache 重建')
      if (!rebuilt.ok) throw new Error(`导入后 cache 重建失败：${rebuilt.error ?? rebuilt.conflict ?? '未知'}`)
      mark('rebuild', 'cache 重建完成')
      await writeImportStageNow('verify')
      const health = await (await import('./native-sqlite')).sqliteHealth(30_000)
      const counts = (health as unknown as { counts?: Record<string, number> }).counts ?? {}
      const [idbStates, idbPlans, idbSettings, idbLogs] = await Promise.all([db.states.count(), db.plans.count(), db.settings.count(), db.reviewLogs.count()])
      if (Number(counts.states ?? -1) !== idbStates || Number(counts.plans ?? -1) !== idbPlans || Number(counts.settings ?? -1) !== idbSettings || Number(counts.review_logs ?? -1) !== idbLogs) {
        throw new Error('导入后 SQLite/IDB counts 不一致')
      }
      await persistLearningWriteSource('sqlite')
      const { persistSettingsWriteMode } = await import('./settings.repo')
      await persistSettingsWriteMode('sqlite').catch(() => undefined)
      // 0.15 B：native sqlite 保持 sqlite；web/未迁移仍 idb（不绕过门禁）
      await applyContentSourceAfterImport(issues)
      await db.meta.put({ key: 'import.sqlite.factsOnlyTiming', value: { at: Date.now(), strategy, stageTiming, importedDecks: [...importedDecks], skippedStates, skippedLogs, filePlans: file.plans.length, fileLogs: file.reviewLogs.length, states: states.length, logs: logs.length, opsTotal: ops.length }, updatedAt: Date.now() })
      await clearImportStageNow()
      mark('verify', '校验完成')
      const report: ImportReport = {
        ok: true,
        kind: 'migration',
        counts: { decks: importedDecks.size, words: importedDecks.size > 0 ? file.words.filter((word) => importedDecks.has(word.deckId)).length : 0, states: states.length, reviewLogs: logs.length, skipped: skippedStates + skippedLogs },
        issues,
        durationMs: Date.now() - startedAt,
      }
      await writeLastImport(report)
      return report
    } catch (error) {
      try {
        await restoreSqliteFactsBackup({ ...(sqliteBackup.manifest.path ? { path: sqliteBackup.manifest.path } : {}), manifest: sqliteBackup.manifest }, { preBackup: async () => ({ ok: true }), skipWriteLock: true })
      } catch { /* ignore */ }
      await persistLearningWriteSource('idb').catch(() => undefined)
      const { persistSettingsWriteMode } = await import('./settings.repo')
      await persistSettingsWriteMode('idb').catch(() => undefined)
      await clearImportStageNow()
      try { await getDb().meta.put({ key: 'import.sqlite.stageDiag', value: { at: Date.now(), error: error instanceof Error ? error.message : String(error), stageTiming }, updatedAt: Date.now() }) } catch { /* ignore */ }
      throw error
    }
}

async function runWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时（>${Math.round(ms / 1000)}s）`)), ms)),
  ])
}

function importMigrationSqlite(input: string | File, opts: ImportOptions = {}): Promise<ImportReport> {
  return opts.skipWriteLock ? importMigrationSqliteInner(input, opts) : withDataWriteLock(() => importMigrationSqliteInner(input, { ...opts, skipWriteLock: true }))
}

// ============ 0.14 P0-4：迁移包内容包三表 → content_kv ============
// key 规范与 packs.repo 一致：`pack:<id>` / `pack-item:<id>` / `content-reject:<id>`。

function migrationPackContentRow(pack: PackRecord): ContentEntityRow {
  return { key: `pack:${pack.id}`, kind: 'pack', json: JSON.stringify(pack), updatedAt: pack.updatedAt ?? pack.createdAt }
}

function migrationPackItemContentRow(item: PackItemRecord): ContentEntityRow {
  return {
    key: `pack-item:${item.id}`,
    kind: 'pack-item',
    json: JSON.stringify(item),
    updatedAt: item.appliedAt ?? item.createdAt ?? Date.now(),
  }
}

function migrationContentRejectContentRow(row: ContentRejectRecord): ContentEntityRow {
  return { key: `content-reject:${row.id}`, kind: 'content-reject', json: JSON.stringify(row), updatedAt: row.rejectedAt }
}

function migrationPackDeletionRow(id: string): ContentEntityRow {
  return { key: `pack:${id}`, kind: 'pack', json: 'null', deleted: true }
}

function migrationPackItemDeletionRow(id: string): ContentEntityRow {
  return { key: `pack-item:${id}`, kind: 'pack-item', json: 'null', deleted: true }
}

function migrationContentRejectDeletionRow(id: string): ContentEntityRow {
  return { key: `content-reject:${id}`, kind: 'content-reject', json: 'null', deleted: true }
}

/**
 * 0.14 P0-4：sqlite 内容写源下，迁移包 contentPacks/packItems/contentRejects 先写 content_kv。
 * - replace：先给本机三表所有行写 tombstone，再 upsert 包内行（`metaExcluded` 含 contentPacks 时保留本机）；
 * - merge/keepNewer：只补本机没有的行（与 IDB 分支语义一致）。
 * idb 内容写源返回 `null`，调用方保持原事务内 IDB 写逻辑完全不变。
 */
async function buildMigrationContentPackRows(
  file: ParsedMigrationFile,
  strategy: 'replace' | 'merge' | 'keepNewer',
): Promise<ContentEntityRow[] | null> {
  if ((await getContentWriteSource()) !== 'sqlite') return null
  if (strategy === 'replace' && file.metaExcluded.includes('contentPacks')) return []
  const db = getDb()
  const [localPacks, localItems, localRejects] = await Promise.all([
    db.packs.toArray(),
    db.packItems.toArray(),
    db.contentRejects.toArray(),
  ])
  const rows: ContentEntityRow[] = []
  if (strategy === 'replace') {
    // B-G2：只 tombstone「本机有但包里没有」的差集，避免同批 entries+deletes 同 key（native 顺序未定义）
    const filePackIds = new Set(file.contentPacks.map((pack) => pack.id))
    const fileItemIds = new Set(file.packItems.map((item) => item.id))
    const fileRejectIds = new Set(file.contentRejects.map((reject) => reject.id))
    for (const pack of localPacks) if (!filePackIds.has(pack.id)) rows.push(migrationPackDeletionRow(pack.id))
    for (const item of localItems) if (!fileItemIds.has(item.id)) rows.push(migrationPackItemDeletionRow(item.id))
    for (const reject of localRejects) if (!fileRejectIds.has(reject.id)) rows.push(migrationContentRejectDeletionRow(reject.id))
    for (const pack of file.contentPacks) rows.push(migrationPackContentRow(pack))
    for (const item of file.packItems) rows.push(migrationPackItemContentRow(item))
    for (const reject of file.contentRejects) rows.push(migrationContentRejectContentRow(reject))
    return rows
  }
  const packIds = new Set(localPacks.map((pack) => pack.id))
  const itemIds = new Set(localItems.map((item) => item.id))
  const rejectIds = new Set(localRejects.map((reject) => reject.id))
  for (const pack of file.contentPacks) if (!packIds.has(pack.id)) rows.push(migrationPackContentRow(pack))
  for (const item of file.packItems) if (!itemIds.has(item.id)) rows.push(migrationPackItemContentRow(item))
  for (const reject of file.contentRejects) if (!rejectIds.has(reject.id)) rows.push(migrationContentRejectContentRow(reject))
  return rows
}

interface MigrationPackContentSnapshot {
  packs: PackRecord[]
  items: PackItemRecord[]
  rejects: ContentRejectRecord[]
}

/** B-G3：contentPacks content_kv 写前快照（IDB cache 与 content_kv 同步即写前事实） */
async function snapshotMigrationPackContent(): Promise<MigrationPackContentSnapshot> {
  const db = getDb()
  const [packs, items, rejects] = await Promise.all([db.packs.toArray(), db.packItems.toArray(), db.contentRejects.toArray()])
  return { packs, items, rejects }
}

/**
 * B-G3 补偿：contentPacks content_kv 已写、后续 IDB 大事务失败/部分批失败 → 用写前快照恢复 content_kv：
 * 快照行 upsert 回来；写前不存在的 key 写 tombstone。恢复失败抛结构化错误。
 */
async function restoreMigrationPackContent(
  snapshot: MigrationPackContentSnapshot,
  writtenRows: readonly ContentEntityRow[],
): Promise<void> {
  const restoreRows: ContentEntityRow[] = [
    ...snapshot.packs.map((pack) => migrationPackContentRow(pack)),
    ...snapshot.items.map((item) => migrationPackItemContentRow(item)),
    ...snapshot.rejects.map((reject) => migrationContentRejectContentRow(reject)),
  ]
  const priorKeys = new Set(restoreRows.map((row) => row.key))
  for (const row of writtenRows) {
    if (!priorKeys.has(row.key)) restoreRows.push({ key: row.key, kind: row.kind, json: 'null', deleted: true, updatedAt: Date.now() })
  }
  // 补偿必须写回 content_kv（此处调用前提是写前 content 源为 sqlite；期间 source 不应影响补偿）
  const { writeContentRows } = await import('./content-store')
  const { applyContentCache } = await import('./content-write-source')
  const upserts = restoreRows.filter((row) => row.deleted !== true)
  const deletes = restoreRows.filter((row) => row.deleted === true)
  const saved = await writeContentRows([
    ...upserts.map((row) => ({ key: row.key, kind: row.kind, json: row.json, updatedAt: row.updatedAt })),
    ...deletes.map((row) => ({ key: row.key, kind: row.kind, json: 'null' as const, deleted: true as const })),
  ])
  if (!saved.ok) {
    throw new ContentWriteError(`内容包 content_kv 补偿恢复失败：${saved.error ?? '未知错误'}`, 'CONTENT_SQLITE_ROLLBACK_FAILED')
  }
  await applyContentCache(restoreRows).catch(() => undefined)
}

/**
 * 0.14 G1：迁移恢复的 decks/words 先写 content_kv（≤500/批；仅自定义 deck，内置正文不进）。
 * 与 IDB 分支语义对齐：
 * - replace：upsert file deck/new words；对本机已有但新词表没有的词写 word tombstone（含 overlay）；
 * - merge/keepNewer：upsert deck + preserveLocalUserFields 合并后的词（不删本机词）。
 * idb 内容写源返回 null，调用方保持原事务内 IDB 写逻辑完全不变。
 */
async function buildMigrationDeckWordRows(
  file: ParsedMigrationFile,
  strategy: 'replace' | 'merge' | 'keepNewer',
): Promise<ContentEntityRow[] | null> {
  if ((await getContentWriteSource()) !== 'sqlite') return null
  const db = getDb()
  const now = Date.now()
  const rows: ContentEntityRow[] = []
  const wordsByDeck = new Map<string, Word[]>()
  for (const word of file.words) {
    const list = wordsByDeck.get(word.deckId) ?? []
    list.push(word)
    wordsByDeck.set(word.deckId, list)
  }
  // replace 轻量包保留本机同 id 词的引申图（与 IDB 分支 preserveDerivation 一致）
  const localMaps = strategy === 'replace' && file.metaExcluded.includes('derivationMap')
    ? new Map(
        (await db.words.bulkGet(file.words.map((word) => word.id)))
          .filter((word): word is Word => Boolean(word?.derivationMap))
          .map((word) => [word.id, word.derivationMap!] as const),
      )
    : new Map<string, Word['derivationMap']>()
  for (const deck of file.decks) {
    if (isBuiltinDeckFile(deck)) continue // 内置正文来自打包资源，不进 content_kv
    rows.push(contentRowOfDeck(deck))
    let deckWords = wordsByDeck.get(deck.id) ?? []
    if (strategy === 'replace') {
      deckWords = deckWords.map((word) =>
        word.derivationMap === undefined && localMaps.has(word.id) ? { ...word, derivationMap: localMaps.get(word.id) } : word,
      )
      const fileIds = new Set(deckWords.map((word) => word.id))
      const localWords = await db.words.where('deckId').equals(deck.id).toArray()
      for (const word of localWords) {
        if (fileIds.has(word.id)) continue
        rows.push({ key: `word:${word.id}`, kind: 'word', json: 'null', deleted: true, updatedAt: now })
        const overlay = wordOverlayOf(word as unknown as Record<string, unknown>)
        if (Object.keys(overlay).length > 0) {
          rows.push({ key: `word-overlay:${word.id}`, kind: 'word-overlay', json: 'null', deleted: true, updatedAt: now })
        }
      }
    } else {
      const locals = await db.words.bulkGet(deckWords.map((word) => word.id))
      deckWords = deckWords.map((word, index) => preserveLocalUserFields(word, locals[index]))
    }
    for (const word of deckWords) rows.push(contentRowOfWord(word, word.createdAt || now))
  }
  return rows
}

/** 0.15 B：迁移 decks/words 内容写前快照（从 IDB cache 恢复旧 content 行，用于失败补偿） */
async function snapshotMigrationDeckWordContent(rows: readonly ContentEntityRow[]): Promise<ContentEntityRow[]> {
  const db = getDb()
  const prior: ContentEntityRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.deleted === true || seen.has(row.key)) continue
    seen.add(row.key)
    if (row.key.startsWith('deck:')) {
      const deck = await db.decks.get(row.key.slice('deck:'.length))
      if (deck) prior.push(contentRowOfDeck(deck))
    } else if (row.key.startsWith('word:')) {
      const word = await db.words.get(row.key.slice('word:'.length))
      if (word) prior.push(contentRowOfWord(word, Date.now()))
    }
  }
  return prior
}

/** 0.15 B 补偿：导入内容写失败/IDB 事务失败 → 恢复写前 content 行 + 给新增 key 写 tombstone，避免双源分叉 */
async function restoreMigrationDeckWordContent(
  prior: readonly ContentEntityRow[],
  written: readonly ContentEntityRow[],
  label: string,
): Promise<void> {
  const priorKeys = new Set(prior.map((row) => row.key))
  const rows: ContentEntityRow[] = [...prior]
  const seen = new Set(rows.map((row) => row.key))
  for (const row of written) {
    if (row.deleted === true || priorKeys.has(row.key) || seen.has(row.key)) continue
    seen.add(row.key)
    rows.push({ key: row.key, kind: row.kind, json: 'null', deleted: true, updatedAt: Date.now() })
  }
  if (rows.length === 0) return
  const saved = await saveContentEntitiesChunked(rows)
  if (!saved.ok) {
    throw new ContentWriteError(`${label}失败后内容补偿失败：${saved.error ?? '未知错误'}`, 'CONTENT_SQLITE_ROLLBACK_FAILED')
  }
}


async function importMigrationInner(
  input: string | File,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const startedAt = Date.now()
  const strategy = opts.strategy ?? 'replace'
  opts.onProgress?.({ phase: 'read', message: '读取备份文本' })
  const text = await readInput(input)
  opts.onProgress?.({ phase: 'parse', message: '解析 JSON' })
  const json = await parseJsonText(text)
  if (!json.ok) {
    const report = makeReport('migration', json.issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const raw = json.value as Record<string, unknown>
  const issues: ImportIssue[] = []

  // 0) format / version 先判（SPEC §6.2 顺序：format/version → checksum → 字段校验）
  if (raw.format !== 'momo-migration') {
    const report = makeReport(
      'migration',
      [makeIssue('error', 'E_FORMAT', '不是可迁移包（format 应为 momo-migration）', { path: 'format' })],
      {},
      Date.now() - startedAt,
    )
    await writeLastImport(report)
    return report
  }
  if (raw.formatVersion !== 1 || raw.dataVersion !== 1) {
    const report = makeReport(
      'migration',
      [makeIssue('error', 'E_VERSION', '可迁移包版本不支持，请升级 App 后重试', { path: 'formatVersion' })],
      {},
      Date.now() - startedAt,
    )
    await writeLastImport(report)
    return report
  }

  // 1) checksum 校验
  opts.onProgress?.({ phase: 'checksum', message: '校验备份完整性' })
  const checksumPayload = migrationChecksumPayload({
    format: String(raw.format ?? ''),
    formatVersion: Number(raw.formatVersion ?? 0),
    dataVersion: Number(raw.dataVersion ?? 0),
    data: raw.data,
  })
  const expectedChecksum = typeof raw.checksum === 'string' ? raw.checksum : ''
  const { verifyChecksum } = await import('./checksum')
  const checksumResult = await verifyChecksum(checksumPayload, expectedChecksum)
  if (!checksumResult.ok) {
    if (!opts.force) {
      const report = makeReport(
        'migration',
        [
          makeIssue('error', 'E_CHECKSUM', '校验和不匹配，文件可能被修改过（仍要导入请选择「仍要导入」）', {
            path: 'checksum',
          }),
        ],
        {},
        Date.now() - startedAt,
      )
      await writeLastImport(report)
      return report
    }
    issues.push(
      makeIssue('warning', 'E_CHECKSUM', '校验和不匹配，已按「强制导入」继续（数据可能不完整）', {
        path: 'checksum',
      }),
    )
  } else if (checksumResult.matchedAlgo === 'fnv1a64') {
    issues.push(
      makeIssue('warning', 'W_SKIPPED', '该备份文件使用降级校验算法（FNV-1a 64），已通过校验', {
        path: 'checksum',
      }),
    )
  }

  // 2) 字段校验 + 规范化
  opts.onProgress?.({ phase: 'validate', message: '校验数据结构' })
  const parsed = parseMigrationFile(raw)
  if (!parsed.ok) {
    const report = makeReport('migration', [...issues, ...parsed.issues], {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const file = parsed.value
  issues.push(...file.issues)
  if (issues.some((issue) => issue.level === 'error')) {
    const report = makeReport('migration', issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }

  const db = getDb()
  const now = Date.now()
  const deckIds = file.decks.map((deck) => deck.id)
  const importedStates = file.states
  const existingDefaultId =
    (await db.decks.toArray()).find((deck) => deck.isDefault)?.id ?? null

  // 0.14 P0-4：sqlite 内容写源——内容包三表先写 content_kv（≤500/批）；失败结构化返回、不回写 IDB。
  // idb 内容写源 buildMigrationContentPackRows 返回 null，原事务内 IDB 写逻辑完全不变。
  const contentPackRows = await buildMigrationContentPackRows(file, strategy)
  // B-G3：写 content_kv 前快照本机内容包三表（IDB cache），用于失败/IDB 事务失败补偿
  const contentPackPrior = contentPackRows && contentPackRows.length > 0 ? await snapshotMigrationPackContent() : null
  if (contentPackRows && contentPackRows.length > 0) {
    const saved = await saveContentEntitiesChunked(contentPackRows)
    if (!saved.ok) {
      // 已写批次补偿恢复，避免 content_kv 半更新而 IDB 未写
      if (contentPackPrior) {
        await restoreMigrationPackContent(contentPackPrior, contentPackRows.slice(0, saved.written)).catch(() => undefined)
      }
      const report = makeReport(
        'migration',
        [
          ...issues,
          makeIssue(
            'error',
            'E_IO',
            `SQLite 内容包写入失败（已写 ${saved.written}/${contentPackRows.length} 条，失败批未回写 IDB，已尝试补偿）：${saved.error ?? '未知错误'}`,
            { path: 'data.contentPacks' },
          ),
        ],
        {},
        Date.now() - startedAt,
      )
      await writeLastImport(report)
      return report
    }
  }

  // 0.14 G1：sqlite 内容写源下，自定义 decks/words 先写 content_kv（≤500/批）；失败不写 IDB。
  const migrationDeckWordRows = await buildMigrationDeckWordRows(file, strategy)
  // 0.15 B：写前快照本机旧内容（失败时补偿恢复 content_kv，避免 content_kv 与 IDB 分叉）
  const migrationDeckWordPrior = migrationDeckWordRows && migrationDeckWordRows.length > 0
    ? await snapshotMigrationDeckWordContent(migrationDeckWordRows)
    : null
  if (migrationDeckWordRows && migrationDeckWordRows.length > 0) {
    const saved = await saveContentEntitiesChunked(migrationDeckWordRows)
    if (!saved.ok) {
      if (migrationDeckWordPrior) {
        await restoreMigrationDeckWordContent(
          migrationDeckWordPrior,
          migrationDeckWordRows.slice(0, saved.written),
          '迁移自定义 deck/word 写入',
        ).catch(() => undefined)
      }
      throw new ContentWriteError(
        `迁移自定义 deck/word 写入 content_kv 失败（已写 ${saved.written}/${migrationDeckWordRows.length} 条，失败批未回写 IDB）：${saved.error ?? '未知错误'}`,
        'CONTENT_SQLITE_WRITE_FAILED',
      )
    }
  }

  opts.onProgress?.({ phase: 'apply', message: '写入数据库（大库可能需要几十秒）' })
  // 设置写入可能走 SQLite（跨源 await 会让 Dexie 事务失活），必须在事务外执行
  let settingsToApply: Array<{ key: string; value: unknown; updatedAt: number }> = []
  try {
  await db.transaction(
    'rw',
    [db.decks, db.words, db.states, db.reviewLogs, db.settings, db.meta, db.plans, db.packs, db.packItems, db.contentRejects],
    async () => {
      if (strategy === 'replace') {
        // 0.3.61：轻量迁移包（meta.excluded 含 derivationMap）替换导入时，保留本机同 id 词已有的引申图
        const preserveDerivation = file.metaExcluded.includes('derivationMap')
        const localMaps = preserveDerivation
          ? new Map(
              (await db.words.bulkGet(file.words.map((word) => word.id)))
                .filter((word): word is Word => Boolean(word?.derivationMap))
                .map((word) => [word.id, word.derivationMap!] as const),
            )
          : new Map<string, Word['derivationMap']>()
        // 0.10.0：replace 也按 wordId diff（upsert + 仅删多余），绝不清空整段 words
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.decks, file.decks)
        const nextWords = file.words.map((word) =>
          word.derivationMap === undefined && localMaps.has(word.id)
            ? { ...word, derivationMap: localMaps.get(word.id) }
            : word,
        )
        const wordsByDeck = new Map<string, Word[]>()
        for (const word of nextWords) {
          const list = wordsByDeck.get(word.deckId) ?? []
          list.push(word)
          wordsByDeck.set(word.deckId, list)
        }
        for (const deckId of deckIds) {
          await diffReplaceDeckWords(deckId, wordsByDeck.get(deckId) ?? [], 'import-replace')
        }
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.states, importedStates)
        // 0.16 P0-1：replace 必须按 deck 差集删掉“包内没有的 state”。
        // 否则日志/设置已整体替换、state 却残留本机旧值 → 统计/到期/连续打卡自相矛盾。
        {
          const importedStateIds = new Set(importedStates.map((state) => state.wordId))
          for (const deckId of deckIds) {
            const localStateIds = (await db.states.where('deckId').equals(deckId).primaryKeys()) as string[]
            const stale = localStateIds.filter((wordId) => !importedStateIds.has(wordId))
            if (stale.length > 0) await db.states.bulkDelete(stale)
          }
        }
        // replace 必须清空旧日志，否则恢复备份后统计/调度会混入当前库残留
        await db.reviewLogs.clear()
        // 复习日志：追加（去掉自增 id，避免主键冲突）
        const logs = file.reviewLogs.map((log) => {
          const copy: ReviewLog = { ...log }
          delete copy.id
          return copy
        })
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(
          {
            async bulkPut(items: ReviewLog[]) {
              await db.reviewLogs.bulkAdd(items)
            },
          },
          logs,
        )
        // 设置：整体覆盖，但保留本机 token（隐私，D23）与设备本地开关（不应被备份改回）
        const deviceLocalKeys = ['data.maimemoToken', 'ai.apiKey', 'data.autoBackupEnabled'] as const
        const deviceLocalRows = (await db.settings.bulkGet([...deviceLocalKeys])).filter((row): row is NonNullable<typeof row> => Boolean(row))
        await db.settings.clear()
        if (deviceLocalRows.length > 0) await db.settings.bulkPut(deviceLocalRows)
        settingsToApply = file.settings.filter((record) => !deviceLocalKeys.includes(record.key as never) && record.key !== 'data.contentWriteSource') as never
      } else if (strategy === 'merge') {
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.decks, file.decks)
        const localWords = await db.words.bulkGet(file.words.map((word) => word.id))
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(
          db.words,
          file.words.map((word, index) => preserveLocalUserFields(word, localWords[index])),
        )
        const existing = await db.states.bulkGet(importedStates.map((state) => state.wordId))
        const merged: WordState[] = importedStates.map((state, index) => {
          const local = existing[index]
          return local ? mergeState(local, state) : state
        })
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.states, merged)
        // 合并模式不导入复习日志（避免重复计数）；设置只补缺省项
        const localSettings = await db.settings.toArray()
        const localKeys = new Set(localSettings.map((record) => record.key))
        const missing = file.settings.filter((record) => !localKeys.has(record.key) && record.key !== 'data.contentWriteSource')
        settingsToApply = missing as never
        issues.push(
          makeIssue('warning', 'W_SKIPPED', '合并模式未导入复习日志（避免重复计数），学习状态已按时间合并', {
            path: 'data.reviewLogs',
          }),
        )
      } else {
        // keepNewer：仅导入包里的 state 更新时才覆盖本地 state
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.decks, file.decks)
        const localWords = await db.words.bulkGet(file.words.map((word) => word.id))
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(
          db.words,
          file.words.map((word, index) => preserveLocalUserFields(word, localWords[index])),
        )
        const existing = await db.states.bulkGet(importedStates.map((state) => state.wordId))
        const kept: WordState[] = []
        let overwritten = 0
        importedStates.forEach((state, index) => {
          const local = existing[index]
          if (!local) {
            kept.push(state)
            return
          }
          const localAt = local.lastReviewedAt ?? -Infinity
          const importedAt = state.lastReviewedAt ?? -Infinity
          if (importedAt > localAt) {
            overwritten += 1
            kept.push(mergeState(local, state))
          }
        })
        if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.states, kept)
        const localSettings = await db.settings.toArray()
        const localKeys = new Set(localSettings.map((record) => record.key))
        settingsToApply = file.settings.filter((record) => !localKeys.has(record.key) && record.key !== 'data.contentWriteSource') as never
        issues.push(
          makeIssue(
            'warning',
            'W_SKIPPED',
            `keepNewer：仅覆盖了 ${overwritten} 条较新的学习状态，其余保留本机`,
            { path: 'data.states' },
          ),
        )
      }

      // v2：迁移包里的今日 plan（只恢复同一天；旧包/跨天忽略）
      const filePlans = parsed.value.plans ?? []
      if (strategy === 'replace') {
        // 0.16 P0-1：replace 先清本机旧 plan 再写包内今日 plan。
        // 否则“日志=包内、计划=本机旧”会自相矛盾（今日进度/完成态按旧计划算）。
        await db.plans.clear()
        const today = localDateKey(now)
        const accepted = filePlans.filter((plan) => plan.date === today)
        for (const plan of accepted) await db.plans.put(plan)
        const ignored = filePlans.length - accepted.length
        if (ignored > 0) {
          issues.push(
            makeIssue(
              'warning',
              'W_SKIPPED',
              `有 ${ignored} 条非今日的学习计划未恢复（跨天计划无意义，本次替换已清空本机旧计划）`,
              { path: 'data.plans' },
            ),
          )
        }
        if (filePlans.length === 0) {
          issues.push(
            makeIssue(
              'warning',
              'W_SKIPPED',
              '备份包不含今日学习计划（旧版本备份），本次替换已清空本机旧计划；今日进度需重新生成',
              { path: 'data.plans' },
            ),
          )
        }
      } else if (filePlans.length > 0) {
        // 0.16 P1-1：merge/keepNewer 保留本机计划，不再由兜底逻辑覆盖（见 ensureImportedPlansPersisted）
        issues.push(
          makeIssue(
            'warning',
            'W_SKIPPED',
            '合并/保留较新模式下未导入包内今日计划（队列与设备上下文相关，保留本机）',
            { path: 'data.plans' },
          ),
        )
      }
      // v3（task-69）：内容包三表（备份/换机保留 AI 生成内容与拒绝记忆）
      const filePacks = parsed.value.contentPacks ?? []
      const filePackItems = parsed.value.packItems ?? []
      const fileRejects = parsed.value.contentRejects ?? []
      if (strategy === 'replace') {
        // 0.3.61：轻量迁移包不含内容包 → 保留本机内容包，避免换机备份清空 AI 内容
        if (!file.metaExcluded.includes('contentPacks')) {
          await db.packs.clear()
          await db.packItems.clear()
          await db.contentRejects.clear()
          if (filePacks.length > 0) if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.packs, filePacks)
          if (filePackItems.length > 0) if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.packItems, filePackItems)
          if (fileRejects.length > 0) if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.contentRejects, fileRejects)
        }
      } else {
        // merge / keepNewer：只补本机没有的 pack / packItem / 拒绝记录（避免覆盖本机审核状态）
        const existingPackIds = new Set((await db.packs.toArray()).map((pack) => pack.id))
        const existingItemIds = new Set((await db.packItems.toArray()).map((item) => item.id))
        const existingRejectIds = new Set((await db.contentRejects.toArray()).map((row) => row.id))
        const newPacks = filePacks.filter((pack) => !existingPackIds.has(pack.id))
        const newItems = filePackItems.filter((item) => !existingItemIds.has(item.id))
        const newRejects = fileRejects.filter((row) => !existingRejectIds.has(row.id))
        if (newPacks.length > 0) if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.packs, newPacks)
        if (newItems.length > 0) if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.packItems, newItems)
        if (newRejects.length > 0) if (opts.shouldAbort?.()) throw new Error('恢复已取消（超时/中断）')
      await bulkPutChunked(db.contentRejects, newRejects)
        if (filePacks.length > 0) {
          issues.push(
            makeIssue(
              'warning',
              'W_SKIPPED',
              `合并/保留较新模式：只补入 ${newPacks.length} 个本机没有的内容包，本机审核状态保持不变`,
              { path: 'data.contentPacks' },
            ),
          )
        }
      }

      // 默认词库全局唯一（QA-01）：已有默认词库优先，其次包内第一个默认，否则第一个词库
      await ensureSingleDefaultDeck(existingDefaultId)
      // 选中词库兜底：当前选中的词库不在导入包里就切到默认/第一个
      const selected = await db.settings.get('data.selectedDeckId')
      const selectedId = selected?.value as string | undefined
      const decksNow = await db.decks.toArray()
      if (!selectedId || !decksNow.some((deck) => deck.id === selectedId)) {
        if (decksNow.length > 0) {
          const fallback = decksNow.find((deck) => deck.isDefault) ?? decksNow[0]!
          await db.settings.put({ key: 'data.selectedDeckId', value: fallback.id, updatedAt: now })
        }
      }
    },
  )
  } catch (error) {
    // B-G3/0.15 B：IDB 大事务失败 → 用快照恢复 contentPacks 与 decks/words content_kv，保持双源一致后再抛
    if (contentPackPrior) {
      await restoreMigrationPackContent(contentPackPrior, contentPackRows ?? []).catch(() => undefined)
    }
    if (migrationDeckWordPrior) {
      await restoreMigrationDeckWordContent(migrationDeckWordPrior, migrationDeckWordRows ?? [], '迁移自定义 deck/word 写入').catch(() => undefined)
    }
    throw error
  }

  if (settingsToApply.length > 0) await applyImportedSettings(settingsToApply)

  const report = makeReport(
    'migration',
    issues,
    {
      decks: file.decks.length,
      words: file.words.length,
      states: file.states.length,
      reviewLogs: strategy === 'replace' ? file.reviewLogs.length : 0,
      skipped: issues.filter((issue) => issue.code === 'W_SKIPPED').length,
    },
    Date.now() - startedAt,
  )
  // 0.15 B：native sqlite 保持 sqlite（差集 tombstone 旧行）；web/未迁移仍 idb
  await applyContentSourceAfterImport(issues)
  opts.onProgress?.({ phase: 'done', message: '导入完成' })
  if (strategy === 'replace') await bumpDataEpoch('importMigration:replace')
  await writeLastImport(report)
  return report
}

// ============ 0.14 QA P0：content_kv 清空 ============
// 迁移包内容包写入见上文 buildMigrationContentPackRows（P0-4），此处只负责 clearAllData 的 content_kv 清空。

/** 分页列出 content_kv 全部行（含 tombstone，若 native 返回）；按 revision 前进 */
async function listAllContentRows(): Promise<ContentKvRow[]> {
  const rows: ContentKvRow[] = []
  let since = 0
  for (let page = 0; page < 1_000_000; page += 1) {
    const result = await listContentByRevision(since, 500)
    if (!result.ok) throw new ContentWriteError(result.error ?? '读取 content_kv 失败', 'CONTENT_SQLITE_WRITE_FAILED')
    rows.push(...result.rows)
    if (!result.hasMore || result.rows.length === 0) break
    const maxRevision = Math.max(...result.rows.map((row) => row.revision))
    if (maxRevision <= since) break
    since = maxRevision
  }
  return rows
}

/** content_kv 是否可能含内容：sqlite 写源 / 影子迁移存在 / revision>0 */
async function hasContentKvRows(): Promise<boolean> {
  if (!isSqliteAvailable()) return false
  if ((await getContentWriteSource()) === 'sqlite') return true
  try {
    if (await getContentMigrationState()) return true
    return (await readContentRevision()) > 0
  } catch {
    return false
  }
}

/**
 * 清空全部 content_kv（写 tombstone，保留删除标记供增量备份；不清 revision）。
 * 必须在清 IDB 之前调用：任一失败 → 用快照把已清行按原状态恢复，再抛结构化错误；IDB 完全未动。
 */
async function clearContentKvForClearAll(): Promise<number> {
  const rows = await listAllContentRows()
  if (rows.length === 0) return 0
  const tombstones: ContentEntityRow[] = rows.map((row) => ({
    key: row.key,
    kind: row.kind,
    json: row.json,
    updatedAt: row.updatedAt,
    deleted: true,
  }))
  let written = 0
  try {
    for (let i = 0; i < tombstones.length; i += 500) {
      const chunk = tombstones.slice(i, i + 500)
      // 直接写 content_kv（不按当前写源路由）：即便写源已回 idb，只要迁移存在也要清事实源
      const saved = await writeContentRows(chunk)
      if (!saved.ok) {
        throw new ContentWriteError(
          `清空 content_kv 失败（已写 ${written}/${tombstones.length} 条）：${saved.error ?? '未知错误'}`,
          'CONTENT_SQLITE_WRITE_FAILED',
        )
      }
      written += chunk.length
    }
  } catch (error) {
    const causeMessage = error instanceof Error ? error.message : String(error)
    // 补偿：把已写 tombstone 的行恢复为删除前内容（含原 deleted 状态）
    const restoreRows: ContentEntityRow[] = rows.slice(0, written).map((row) => ({
      key: row.key,
      kind: row.kind,
      json: row.json,
      updatedAt: row.updatedAt,
      ...(row.deleted === 1 ? { deleted: true } : {}),
    }))
    try {
      for (let i = 0; i < restoreRows.length; i += 500) {
        const restored = await writeContentRows(restoreRows.slice(i, i + 500))
        if (!restored.ok) throw new Error(restored.error ?? '未知错误')
      }
    } catch (restoreError) {
      const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError)
      throw new ContentWriteError(
        `清空 content_kv 失败（${causeMessage}），且内容恢复失败（${restoreMessage}）；请从备份恢复`,
        'CONTENT_SQLITE_ROLLBACK_FAILED',
      )
    }
    throw error instanceof ContentWriteError ? error : new ContentWriteError(causeMessage, 'CONTENT_SQLITE_WRITE_FAILED')
  }
  return written
}

// ============ 0.15 B：导入/恢复后的内容写源（task-294） ============
// 调用 task-293 content-switch.ensureContentSourceAfterImport（native sqlite 保持，不 reset；web/未迁移仍 idb）。
// 失败 fail-closed：保持调用前写源，写 diag + 导入告警（不改变已导入内容）。

/** 0.15 B：导入/恢复成功后的写源收敛；失败只告警，不改导入结果 */
async function applyContentSourceAfterImport(issues?: ImportIssue[]): Promise<void> {
  const result = await ensureContentSourceAfterImport()
  if (result.ok) return
  try {
    await getDb().meta.put({ key: 'import.contentSourceAfterImport.diag', value: { at: Date.now(), ...result }, updatedAt: Date.now() })
  } catch {
    /* diag 失败不影响主流程 */
  }
  if (issues) {
    issues.push(makeIssue('warning', 'E_IO', `导入后内容写源处理失败：${result.error ?? '未知错误'}（已保持导入前写源：${result.source}）`, { path: 'data.contentWriteSource' }))
  }
}

// ============ 清空数据 ============

/**
 * 清空全部数据（危险操作，UI 需二次确认）。
 * - 清 decks/words/states/reviewLogs/settings/meta；
 * - `keepToken=true` 时保留 `data.maimemoToken`；`keepAiKey=true` 时保留 `ai.apiKey`（默认一起清，D23/task-70）；
 * - v3：同时清空内容包三表；清空后内置词库需要重新 `ensureBuiltinDecks()`。
 */
export function clearAllData(
  opts: {
    keepToken?: boolean
    keepAiKey?: boolean
    /** 0.10.0：执行前强制预备份；不提供且 unsafe!=true 时拒绝执行 */
    preBackup?: () => Promise<void | { ok: boolean; error?: string }>
    /** 仅供内部测试/重置；UI 不得使用 */
    unsafe?: boolean
    /** 0.10.0：清空后删除 native 检查点文件，避免重启复活 */
    checkpointBridge?: AutoBackupBridge
  } = {},
): Promise<void> {
  return withDataWriteLock(() => clearAllDataInner(opts))
}

async function clearAllDataInner(
  opts: {
    keepToken?: boolean
    keepAiKey?: boolean
    preBackup?: () => Promise<void | { ok: boolean; error?: string }>
    unsafe?: boolean
    checkpointBridge?: AutoBackupBridge
  } = {},
): Promise<void> {
  const learningSource = getLearningWriteSource()
  if (!opts.unsafe) {
    if (!opts.preBackup) throw new Error('清空数据前必须先备份（preBackup 未提供）')
    const backup = await opts.preBackup()
    if (backup && backup.ok === false) throw new Error(`预备份失败，已拒绝清空：${backup.error ?? '未知错误'}`)
  }
  const db = getDb()
  const tokenRow = opts.keepToken ? await db.settings.get('data.maimemoToken') : undefined
  const aiKeyRow = opts.keepAiKey ? await db.settings.get('ai.apiKey') : undefined
  // P0-1：SQLite 清空可能跨多批；先做当前 SQLite 安全快照（含 content_kv），失败可回滚。
  let clearSafety: Awaited<ReturnType<typeof createSqliteFactsBackup>> | null = null
  if (learningSource !== 'idb' && isSqliteAvailable()) {
    clearSafety = await createSafetySnapshot()
    if ((!clearSafety.ok || !clearSafety.manifest?.path) && !opts.unsafe) {
      throw new Error('无法创建清空安全快照，已拒绝清空（避免 IDB/SQLite 半清空）')
    }
  }
  const recoverClearFailure = async (): Promise<boolean> => {
    if (!clearSafety?.ok || !clearSafety.manifest?.path) return false
    try {
      const restored = await restoreSqliteFactsBackup(
        { path: clearSafety.manifest.path, manifest: clearSafety.manifest },
        { preBackup: async () => ({ ok: true }), skipWriteLock: true, allowEmptySafety: true },
      )
      if (!restored.ok) return false
      const rebuilt = await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true })
      if (!rebuilt.ok) return false
      await persistLearningWriteSource(learningSource)
      if (learningSource === 'sqlite') {
        const { persistSettingsWriteMode } = await import('./settings.repo')
        await persistSettingsWriteMode('sqlite').catch(() => undefined)
      }
      return true
    } catch {
      return false
    }
  }
  try {
    // 先清 SQLite（分批/all:true），成功后再清 IDB/content；失败时 IDB 仍完整，可回滚。
    if (learningSource !== 'idb') {
      await clearAllSqliteFacts()
    }
    // 0.14 QA P0：清 content_kv（内容事实源）；失败会补偿已写 tombstone，再由 safety 恢复兜底。
    if (await hasContentKvRows()) {
      await clearContentKvForClearAll()
    }
    await db.transaction(
      'rw',
      [db.decks, db.words, db.states, db.reviewLogs, db.settings, db.meta, db.plans, db.packs, db.packItems, db.contentRejects],
      async () => {
        await db.packs.clear()
        await db.packItems.clear()
        await db.contentRejects.clear()
        await db.plans.clear()
        await db.decks.clear()
        await db.words.clear()
        await db.states.clear()
        await db.reviewLogs.clear()
        await db.settings.clear()
        await db.meta.clear()
        // D-P0-3：clearedAt 与 meta.clear 同事务，避免清空后被杀导致旧检查点复活。
        await db.meta.put({ key: 'data.clearedAt', value: { at: Date.now() }, updatedAt: Date.now() })
        if (tokenRow) await db.settings.put(tokenRow)
        if (aiKeyRow) await db.settings.put(aiKeyRow)
      },
    )
    if (learningSource !== 'idb') {
      // D-P0-3：清空后保持 SQLite 单一事实源，不再切回 idb 制造双源窗口。
      await persistLearningWriteSource('sqlite')
      try {
        const { writeIdbCacheMeta } = await import('./idb-cache')
        const { SQLITE_SCHEMA_VERSION } = await import('./sqlite-store')
        const { getDataEpoch } = await import('./data-epoch')
        await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false, rebuiltAt: Date.now(), reason: 'clear-all-sqlite' })
      } catch { /* 下次启动会重建 */ }
    }
  } catch (error) {
    const recovered = await recoverClearFailure()
    if (!recovered && learningSource !== 'idb') {
      await persistLearningWriteSource('readonly').catch(() => undefined)
    }
    throw new Error(
      `清空失败${recovered ? '，已从安全快照回滚' : '，安全快照回滚失败；请从完整备份恢复'}：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (clearSafety?.ok && clearSafety.manifest) {
    const { deleteSafetySnapshot } = await import('./sqlite-backup')
    await deleteSafetySnapshot(clearSafety.manifest).catch(() => undefined)
  }
  // 0.10.0：有 bridge 时立即删除 checkpoint 文件
  if (opts.checkpointBridge) {
    try {
      await deleteStateCheckpointFiles(opts.checkpointBridge)
      await db.meta.delete('checkpoint.clearDeleteFailed')
    } catch (error) {
      // 删除失败可验证；clearedAt 仍会阻止旧检查点恢复
      await db.meta.put({
        key: 'checkpoint.clearDeleteFailed',
        value: { at: Date.now(), error: error instanceof Error ? error.message : String(error) },
        updatedAt: Date.now(),
      })
    }
  }
  await bumpDataEpoch('clearAllData')
}

// ============ 杂项 ============

/** 读取上次导入报告（设置页展示，§2.2 key `import:last`） */
export async function getLastImportReport(): Promise<ImportReport | null> {
  const db = getDb()
  const row = await db.meta.get('import:last')
  const value = row?.value as { report?: ImportReport } | undefined
  return value?.report ?? null
}

/** 当前设置（导出给 UI 的便捷再导出，避免 UI 直接 import settings.repo） */
export { getSettings }

// 0.11.1 保留内部 staging 实现，rc3 不启用；导出避免死代码告警。
export { importMigrationSqliteStaging, importMigrationSqlite }
