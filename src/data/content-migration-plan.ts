/**
 * 0.14：IDB 内容 → content_kv 迁移计划（影子迁移安全闭环）
 *
 * 本轮修复（qa-0.14-closure-checklist B-D2 / B-D3 / B-D4 / S4 / S7）：
 * - B-D2：写入前对全部受影响 key 做 content_kv 快照（key/kind/json/deleted/revision），
 *   写入/校验/中断任一失败按快照 undo（恢复旧行、删除本次新建 key），覆盖所有已写批；
 *   失败不碰 IDB 事实源、不切写源。
 * - B-D3：counts 按 kind + deleted 精确校验（含迁移前 tombstone 基线），再对 ≥20 条
 *   （小库全量）抽样做内容 hash 校验，不一致即失败并 undo。
 * - B-D4：ready 状态记录本次 IDB 内容指纹；formal 在 ready 时比对当前指纹，
 *   指纹变化 → 判定 stale 并重跑 shadow（不幂等）。
 * - S4/S7：shadow/formal 全程 withDataWriteLock 串行；迁移前后计算 IDB 内容指纹，
 *   快照与写入之间 IDB 内容变化 → E_CONTENT_CHANGED 需重跑，不写坏影子表。
 */
import { buildContentSnapshot, exportContentEntities, hashContentValue, wordOverlayOf, CONTENT_META_PREFIXES } from './content-snapshot'
import type { ContentCountsResult, ContentKind, ContentKvRow, ContentWriteInput } from './content-store'
import { CONTENT_KV_STALE_KEY, assertContentSchemaVersion, listContentRowsPage, readContentCounts, readContentRows, writeContentRows } from './content-store'
import { getDb } from './db'
import { writeIdbCacheMeta } from './idb-cache'
import { getDataEpoch } from './data-epoch'
import { SQLITE_SCHEMA_VERSION } from './sqlite-store'
import { DECK_SOURCES } from './builtin/deck-sources'
import { BUILTIN_DECK_IDS, parseBuiltinDeckFile } from './builtin'
import { withDataWriteLock } from './write-lock'
import {
  getContentMigrationV15State,
  getContentWriteSource,
  getLegacyContentWriteSource,
  isContentSourceEmergencyIdb,
  isContentMigrationV15Done,
  isNativeContentSqliteRuntime,
  persistContentWriteSource,
  writeContentMigrationV15State,
} from './content-write-source'
import type { ContentMigrationV15From, ContentMigrationV15State, ContentWriteSource } from './content-write-source'

export interface ContentMigrationBatch {
  index: number
  rows: ContentWriteInput[]
}

const KIND_MAP: Record<string, ContentKind> = {
  decks: 'deck',
  words: 'word',
  wordOverlay: 'word-overlay',
  packs: 'pack',
  packItems: 'pack-item',
  contentRejects: 'content-reject',
  meta: 'meta',
}

function keyFor(type: string, key: string): string {
  if (type === 'meta') return `meta:${key}`
  if (type === 'wordOverlay') return `word-overlay:${key}`
  if (type === 'packItems') return `pack-item:${key}`
  if (type === 'contentRejects') return `content-reject:${key}`
  return `${type === 'decks' ? 'deck' : type === 'words' ? 'word' : type === 'packs' ? 'pack' : type}:${key}`
}

/** 生成迁移批次（默认200/批）；不写任何库；调用方负责 preflight/失败回滚/切源 */
export async function buildContentMigrationPlan(opts: { batchSize?: number; shouldAbort?: () => boolean } = {}): Promise<ContentMigrationBatch[]> {
  const batchSize = Math.max(50, Math.min(500, Math.floor(opts.batchSize ?? 200)))
  const snapshot = await buildContentSnapshot({ revision: 0 })
  const entities = await exportContentEntities(snapshot.entries, { ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}) })
  const rows = entities.map((entity) => ({
    key: keyFor(entity.type, entity.key),
    kind: KIND_MAP[entity.type] ?? 'meta',
    json: JSON.stringify(entity.data),
    updatedAt: entity.updatedAt,
  }))
  const batches: ContentMigrationBatch[] = []
  for (let i = 0; i < rows.length; i += batchSize) batches.push({ index: batches.length, rows: rows.slice(i, i + batchSize) })
  return batches
}

export interface ContentMigrationBatchRunOptions {
  shouldAbort?: () => boolean
  /** 每批写成功后回调（诊断/测试观察已写批；不影响失败语义） */
  onBatchWritten?: (batch: ContentMigrationBatch) => void
}

export async function runContentMigrationBatches(
  batches: readonly ContentMigrationBatch[],
  write: (rows: ContentWriteInput[]) => Promise<{ ok: boolean; revision: number; error?: string }>,
  opts: ContentMigrationBatchRunOptions = {},
): Promise<{ ok: boolean; written: number; revision: number; error?: string }> {
  let written = 0
  let revision = 0
  for (const batch of batches) {
    if (opts.shouldAbort?.()) return { ok: false, written, revision, error: 'E_ABORTED: 迁移已取消' }
    const result = await write(batch.rows)
    if (!result.ok) return { ok: false, written, revision, error: result.error ?? '迁移写入失败' }
    written += batch.rows.length
    revision = result.revision
    opts.onBatchWritten?.(batch)
  }
  return { ok: true, written, revision }
}

export const CONTENT_MIGRATION_STATE_KEY = 'contentMigrationState'

/** S4：IDB 内容指纹（只读）。覆盖 decks/words/packs/packItems/contentRejects 全表 + 内容 meta 前缀。 */
export interface ContentIdbFingerprint {
  version: 1
  counts: Record<string, number>
  hash: string
  at: number
}

interface FingerprintTablePart {
  name: string
  count: number
  hash: string
}

export async function computeContentIdbFingerprint(now: number = Date.now()): Promise<ContentIdbFingerprint> {
  const db = getDb()
  const parts: FingerprintTablePart[] = []
  const counts: Record<string, number> = {}
  const addTable = (name: string, rows: ReadonlyArray<{ key: string; value: unknown }>) => {
    const entries = rows.map((row) => ({ key: row.key, hash: hashContentValue(row.value) })).sort((a, b) => a.key.localeCompare(b.key))
    counts[name] = entries.length
    parts.push({ name, count: entries.length, hash: hashContentValue(entries) })
  }
  const rowsOf = async (table: { toArray: () => Promise<unknown[]> }) => (await table.toArray()).map((row) => ({ key: String((row as { id: unknown }).id), value: row }))
  addTable('decks', await rowsOf(db.decks))
  addTable('words', await rowsOf(db.words))
  addTable('packs', await rowsOf(db.packs))
  addTable('packItems', await rowsOf(db.packItems))
  addTable('contentRejects', await rowsOf(db.contentRejects))
  const metaRows = (await db.meta.toArray()).filter((row) => CONTENT_META_PREFIXES.some((prefix) => row.key.startsWith(prefix)))
  addTable('meta', metaRows.map((row) => ({ key: row.key, value: row.value })))
  return { version: 1, counts, hash: hashContentValue(parts), at: now }
}

export function isSameContentIdbFingerprint(a: ContentIdbFingerprint | null | undefined, b: ContentIdbFingerprint | null | undefined): boolean {
  if (!a || !b || a.version !== 1 || b.version !== 1) return false
  if (a.hash !== b.hash) return false
  const names = new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])
  for (const name of names) if ((a.counts[name] ?? 0) !== (b.counts[name] ?? 0)) return false
  return true
}

export interface ContentMigrationStateView {
  status?: string
  writeCoverageComplete?: boolean
  error?: string
  written?: number
  expected?: number
  revision?: number
  needsRerun?: boolean
  undoError?: string
  at?: number
  idbFingerprint?: ContentIdbFingerprint
}

export async function getContentMigrationState(): Promise<ContentMigrationStateView | null> {
  return ((await getDb().meta.get(CONTENT_MIGRATION_STATE_KEY))?.value as ContentMigrationStateView | undefined) ?? null
}

async function writeMigrationState(status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await getDb().meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status, writeCoverageComplete: false, at: Date.now(), ...extra }, updatedAt: Date.now() })
}

/**
 * 覆盖自检通过后置位：只允许 Lead/QA 在所有写入口与审计项 PASS 后调用。
 * 不自动置 true；迁移状态必须 ready、content_kv 非空、IDB 指纹未变化。
 */
export async function finalizeContentWriteCoverage(): Promise<{ ok: boolean; error?: string }> {
  const state = await getContentMigrationState()
  if (!state) return { ok: false, error: '未执行影子迁移' }
  if (state.status !== 'ready') return { ok: false, error: `迁移状态不是 ready（${state.status ?? 'unknown'}）` }
  const counts = await readContentCounts().catch(() => null)
  if (!counts || counts.total <= 0) return { ok: false, error: 'content_kv 为空或无法读取 counts' }
  if (state.idbFingerprint) {
    const current = await computeContentIdbFingerprint()
    if (!isSameContentIdbFingerprint(state.idbFingerprint, current)) {
      return { ok: false, error: '迁移后 IDB 内容已变化，需要重跑迁移' }
    }
  }
  await getDb().meta.put({
    key: CONTENT_MIGRATION_STATE_KEY,
    value: { ...state, writeCoverageComplete: true, coverageFinalizedAt: Date.now(), at: Date.now() },
    updatedAt: Date.now(),
  })
  return { ok: true }
}

/** 只有影子迁移 ready 且所有写入口覆盖完成才允许切源 */
export async function canSwitchContentWriteSource(): Promise<{ ok: boolean; reason?: string }> {
  if (await getDb().meta.get(CONTENT_KV_STALE_KEY)) {
    return { ok: false, reason: 'content_kv 已因导入回退而过期，需先在调试页清理过期内容库' }
  }
  const state = await getContentMigrationState()
  if (!state) return { ok: false, reason: '未执行影子迁移' }
  if (state.status !== 'ready') return { ok: false, reason: `影子迁移状态不是 ready（${state.status ?? 'unknown'}）` }
  if (state.writeCoverageComplete !== true) return { ok: false, reason: '内容写入口覆盖未完成' }
  const counts = await readContentCounts().catch(() => null)
  if (!counts || counts.total <= 0) return { ok: false, reason: 'content_kv 为空或无法读取 counts' }
  return { ok: true }
}

const CONTENT_WRITE_CHUNK = 500
const MIGRATION_SAMPLE_MIN = 20
const UNDO_CONFLICT_RETRY = 2

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureMessage(base: string, undoError: string | null): string {
  return undoError ? `${base}；content_kv 回滚失败（需要重跑）：${undoError}` : base
}

/** undo 专用：分块写，E_CONFLICT 重试（迁移期间用户写入/自动任务可能推进 revision） */
async function writeContentRowsStrict(rows: readonly ContentWriteInput[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CONTENT_WRITE_CHUNK) {
    const chunk = rows.slice(i, i + CONTENT_WRITE_CHUNK)
    for (let attempt = 0; ; attempt += 1) {
      const result = await writeContentRows(chunk)
      if (result.ok) break
      const conflict = (result.error ?? '').includes('E_CONFLICT')
      if (!conflict || attempt >= UNDO_CONFLICT_RETRY) throw new Error(result.error ?? 'content_kv 写入失败')
    }
  }
}

/** B-D2：写前快照 → undo：旧 live 行原样恢复、旧 tombstone 重新置 deleted、写前不存在的 key 删除 */
function makeContentKvUndo(before: Map<string, ContentKvRow>, affectedKinds: Map<string, ContentKind>): () => Promise<void> {
  return async () => {
    const rows: ContentWriteInput[] = []
    for (const [key, old] of before) {
      if (old.deleted === 0) rows.push({ key, kind: old.kind, json: old.json, updatedAt: old.updatedAt })
      else rows.push({ key, kind: old.kind, json: 'null', deleted: true })
    }
    for (const [key, kind] of affectedKinds) if (!before.has(key)) rows.push({ key, kind, json: 'null', deleted: true })
    await writeContentRowsStrict(rows)
  }
}

async function attemptContentKvUndo(undo: (() => Promise<void>) | null): Promise<string | null> {
  if (!undo) return null
  try {
    await undo()
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

/**
 * B-D2：读取全部受影响 key 的当前行。
 * - key 少（≤500）：contentGet 批量按 key 精确读；
 * - key 多：contentList 全量分页（按 key 排序 + offset，含 tombstone）后按 key 过滤，
 *   避免大量 IN 查询；两种方式都返回 key/kind/json/deleted/revision 全字段。
 */
async function readContentKvRowsForKeys(keys: readonly string[]): Promise<Map<string, ContentKvRow>> {
  const map = new Map<string, ContentKvRow>()
  if (keys.length === 0) return map
  if (keys.length > CONTENT_WRITE_CHUNK) {
    const wanted = new Set(keys)
    let offset = 0
    for (let page = 0; page < 10_000; page += 1) {
      const result = await listContentRowsPage({ offset, limit: 1000, includeDeleted: true })
      if (!result.ok) throw new Error(result.error ?? '读取 content_kv 失败')
      for (const row of result.rows) if (wanted.has(row.key)) map.set(row.key, row)
      if (!result.hasMore || result.rows.length === 0) return map
      offset += result.rows.length
    }
    throw new Error('content_kv 全量分页超出上限')
  }
  const result = await readContentRows(keys)
  if (!result.ok) throw new Error(result.error ?? '读取 content_kv 失败')
  for (const row of result.rows) map.set(row.key, row)
  return map
}

function hashJson(json: string): string | null {
  try {
    return hashContentValue(JSON.parse(json) as unknown)
  } catch {
    return null
  }
}

/** 确定性抽样：小库全量，大库按 (kind,key) 排序均匀取 ≥20 条 */
function sampleMigrationRows(rows: readonly ContentWriteInput[], minimum = MIGRATION_SAMPLE_MIN): ContentWriteInput[] {
  if (rows.length <= minimum) return [...rows]
  const sorted = [...rows].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
  const out: ContentWriteInput[] = []
  const step = sorted.length / minimum
  for (let i = 0; i < minimum; i += 1) {
    const row = sorted[Math.floor(i * step)]
    if (row) out.push(row)
  }
  return out
}

/** B-D3：counts 按 kind + deleted 校验（迁移前 tombstone 基线参与），再抽样校验内容 hash */
async function verifyContentKvMigration(
  planRows: readonly ContentWriteInput[],
  beforeRows: Map<string, ContentKvRow>,
  beforeCounts: ContentCountsResult,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!beforeCounts.ok) return { ok: false, error: `迁移前 content_kv counts 读取失败${beforeCounts.error ? `：${beforeCounts.error}` : ''}` }
  const expectedByKind: Record<string, number> = { ...beforeCounts.byKind }
  let expectedTotal = beforeCounts.total
  let expectedDeleted = beforeCounts.deleted
  for (const row of planRows) {
    const old = beforeRows.get(row.key)
    if (!old) {
      expectedTotal += 1
      expectedByKind[row.kind] = (expectedByKind[row.kind] ?? 0) + 1
      continue
    }
    // native contentCounts：total/byKind 含 tombstone 行；覆盖 tombstone → live 只减 deleted
    if (old.deleted === 1) expectedDeleted -= 1
    expectedByKind[old.kind] = (expectedByKind[old.kind] ?? 0) - 1
    expectedByKind[row.kind] = (expectedByKind[row.kind] ?? 0) + 1
  }
  for (const kind of Object.keys(expectedByKind)) if (expectedByKind[kind] === 0) delete expectedByKind[kind]
  const actual = await readContentCounts()
  if (!actual.ok) return { ok: false, error: `迁移后 content_kv counts 读取失败${actual.error ? `：${actual.error}` : ''}` }
  if (actual.total !== expectedTotal) return { ok: false, error: `content_kv total 不一致（实际 ${actual.total}/期望 ${expectedTotal}）` }
  if (actual.deleted !== expectedDeleted) return { ok: false, error: `content_kv deleted 不一致（实际 ${actual.deleted}/期望 ${expectedDeleted}）` }
  const kinds = new Set([...Object.keys(expectedByKind), ...Object.keys(actual.byKind)])
  for (const kind of kinds) {
    const got = actual.byKind[kind] ?? 0
    const want = expectedByKind[kind] ?? 0
    if (got !== want) return { ok: false, error: `content_kv kind=${kind} 计数不一致（实际 ${got}/期望 ${want}）` }
  }
  const samples = sampleMigrationRows(planRows)
  const actualSamples = await readContentKvRowsForKeys(samples.map((row) => row.key))
  for (const row of samples) {
    const stored = actualSamples.get(row.key)
    if (!stored) return { ok: false, error: `content_kv 缺少迁移行：${row.key}` }
    if (stored.deleted !== 0) return { ok: false, error: `content_kv 迁移行是 tombstone：${row.key}` }
    if (stored.kind !== row.kind) return { ok: false, error: `content_kv kind 不一致：${row.key}（实际 ${stored.kind}/期望 ${row.kind}）` }
    const storedHash = hashJson(stored.json)
    const expectedHash = hashJson(row.json)
    if (storedHash === null || expectedHash === null || storedHash !== expectedHash) return { ok: false, error: `content_kv 内容 hash 不一致：${row.key}` }
  }
  return { ok: true }
}

export interface ShadowMigrationResult {
  ok: boolean
  written: number
  revision: number
  error?: string
  /** true：IDB 内容在迁移期间变化，本次结果不可用，需要重跑 */
  needsRerun?: boolean
  /** 失败 undo 自身失败时的错误（内容可能需要人工重跑） */
  undoError?: string
  idbFingerprint?: ContentIdbFingerprint
}

export interface ShadowMigrationOptions {
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  write?: (rows: ContentWriteInput[]) => Promise<{ ok: boolean; revision: number; error?: string }>
  batchSize?: number
  shouldAbort?: () => boolean
  now?: number
  /** 0.15：调用方已在同一写锁内构建好计划时复用，避免二次全量扫描（v15 一次性迁移用） */
  batches?: readonly ContentMigrationBatch[]
  /** 0.15：计划构建时记录的 IDB 指纹；提供后写前/写后都与它校验，保证批次相对 IDB 未过期 */
  expectedFingerprint?: ContentIdbFingerprint
}

/** 影子迁移主流程（调用方必须已持有写锁；公共入口见下方 runContentMigrationShadow） */
async function runContentMigrationShadowInner(opts: ShadowMigrationOptions = {}): Promise<ShadowMigrationResult> {
  let written = 0
  let revision = 0
  let writtenBatches = 0
  let undo: (() => Promise<void>) | null = null
  let undone = false
  const performUndo = async (): Promise<string | null> => {
    // native contentWrite 单次原子：未成功写过任何批时无需 undo（避免中止时空写回全量行）
    if (undone || !undo || writtenBatches === 0) return null
    undone = true
    return attemptContentKvUndo(undo)
  }
  try {
    await writeMigrationState('running', { startedAt: Date.now() })
    // S4：迁移前记录 IDB 内容指纹；preBackup 之后、写前再校验（防快照/写入之间内容变化）
    // 0.15：调用方已持锁并刚构建好计划时可传入 expectedFingerprint（计划时的 IDB 指纹）
    const fingerprintBefore = opts.expectedFingerprint ?? await computeContentIdbFingerprint()
    if (opts.preBackup) {
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) {
        const error = `preBackup 失败：${backup.error ?? '未知错误'}`
        await writeMigrationState('failed', { error, written: 0 })
        return { ok: false, written: 0, revision: 0, error }
      }
    }
    const batches = opts.batches
      ? [...opts.batches]
      : await buildContentMigrationPlan({
          ...(opts.batchSize ? { batchSize: opts.batchSize } : {}),
          ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
        })
    const planRows = batches.flatMap((batch) => batch.rows)
    const fingerprintAfterPlan = await computeContentIdbFingerprint()
    if (!isSameContentIdbFingerprint(fingerprintBefore, fingerprintAfterPlan)) {
      const error = 'E_CONTENT_CHANGED: 迁移快照期间 IDB 内容发生变化，需要重跑'
      await writeMigrationState('failed', { error, needsRerun: true, idbFingerprint: fingerprintAfterPlan })
      return { ok: false, written: 0, revision: 0, error, needsRerun: true, idbFingerprint: fingerprintAfterPlan }
    }
    const write = opts.write ?? writeContentRows
    const realWrite = opts.write === undefined
    let beforeCounts: ContentCountsResult | null = null
    let beforeRows = new Map<string, ContentKvRow>()
    if (realWrite && planRows.length > 0) {
      // B-D2：写前读取全部受影响 key 的当前行（key/kind/json/deleted/revision；contentGet 分块 ≤500）
      beforeRows = await readContentKvRowsForKeys(planRows.map((row) => row.key))
      beforeCounts = await readContentCounts()
      undo = makeContentKvUndo(beforeRows, new Map(planRows.map((row) => [row.key, row.kind])))
    }
    const result = await runContentMigrationBatches(batches, write, {
      ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
      onBatchWritten: () => {
        writtenBatches += 1
      },
    })
    written = result.written
    revision = result.revision
    if (!result.ok) {
      const undoError = await performUndo()
      const error = failureMessage(result.error ?? '迁移写入失败', undoError)
      await writeMigrationState('failed', { error, written, revision, ...(undoError ? { undoError } : {}) })
      return { ok: false, written, revision, error, ...(undoError ? { undoError } : {}) }
    }
    if (realWrite) {
      if (!beforeCounts) beforeCounts = await readContentCounts()
      const validation = await verifyContentKvMigration(planRows, beforeRows, beforeCounts)
      if (!validation.ok) {
        const undoError = await performUndo()
        const error = failureMessage(`content_kv 校验失败：${validation.error}`, undoError)
        await writeMigrationState('failed', { error, written, revision, ...(undoError ? { undoError } : {}) })
        return { ok: false, written, revision, error, ...(undoError ? { undoError } : {}) }
      }
    }
    // S4：写成功后再次确认 IDB 内容未变化，否则影子表相对 IDB 已过期 → undo + 需重跑
    const fingerprintAfterWrite = await computeContentIdbFingerprint()
    if (!isSameContentIdbFingerprint(fingerprintAfterPlan, fingerprintAfterWrite)) {
      const undoError = await performUndo()
      const error = failureMessage('E_CONTENT_CHANGED: 迁移写入期间 IDB 内容发生变化，需要重跑', undoError)
      await writeMigrationState('failed', { error, needsRerun: true, written, revision, idbFingerprint: fingerprintAfterWrite, ...(undoError ? { undoError } : {}) })
      return { ok: false, written, revision, error, needsRerun: true, ...(undoError ? { undoError } : {}) }
    }
    const expected = planRows.length
    await writeMigrationState('ready', { written, revision, expected, idbFingerprint: fingerprintAfterWrite, needsRerun: false })
    return { ok: true, written, revision, idbFingerprint: fingerprintAfterWrite }
  } catch (error) {
    const undoError = await performUndo()
    const message = failureMessage(errorMessage(error), undoError)
    await writeMigrationState('failed', { error: message, needsRerun: true, ...(undoError ? { undoError } : {}) }).catch(() => undefined)
    return { ok: false, written, revision, error: message, needsRerun: true, ...(undoError ? { undoError } : {}) }
  }
}

/** 影子迁移（S4/S7）：全程 withDataWriteLock，不与其它数据层破坏性写/内容写互穿；不切源 */
export async function runContentMigrationShadow(opts: ShadowMigrationOptions = {}): Promise<ShadowMigrationResult> {
  return withDataWriteLock(async () => {
    if (await getDb().meta.get(CONTENT_KV_STALE_KEY)) {
      return { ok: false, written: 0, revision: 0, error: 'content_kv 已过期（导入后回退 IDB），请先在调试页清理过期内容库再迁移' }
    }
    return runContentMigrationShadowInner(opts)
  })
}

export interface FormalMigrationResult extends ShadowMigrationResult {
  idempotent?: boolean
}

async function runContentMigrationFormalInner(opts: ShadowMigrationOptions = {}): Promise<FormalMigrationResult> {
  const state = await getContentMigrationState()
  if (state?.status === 'ready') {
    const [counts, fingerprint] = await Promise.all([readContentCounts().catch(() => null), computeContentIdbFingerprint()])
    const fresh = Boolean(counts && counts.ok && counts.total > 0 && isSameContentIdbFingerprint(state.idbFingerprint, fingerprint))
    if (fresh && counts) return { ok: true, written: 0, revision: counts.revision, idempotent: true, idbFingerprint: fingerprint }
    // B-D4：ready 但 IDB 内容指纹已变化（或 content_kv 为空）→ 重跑 shadow，不幂等返回
  }
  return runContentMigrationShadowInner(opts)
}

/** 正式迁移（S4/B-D4）：锁内 preflight→shadow；ready 且 IDB 指纹未变才幂等返回，变化则重跑 */
export async function runContentMigrationFormal(opts: ShadowMigrationOptions = {}): Promise<FormalMigrationResult> {
  return withDataWriteLock(async () => {
    if (await getDb().meta.get(CONTENT_KV_STALE_KEY)) {
      return { ok: false, written: 0, revision: 0, error: 'content_kv 已过期（导入后回退 IDB），请先在调试页清理过期内容库再迁移' }
    }
    return runContentMigrationFormalInner(opts)
  })
}

/* ========================================================================== *
 * 0.15：原生 SQLite 单一事实源 — v15 一次性迁移
 *
 * 不变量（Lead 0.15 约束，写死）：
 * 1) 原生 APK（MomoBridge momo-apk + 原生 SQLite 可用）= SQLite 唯一事实源；
 *    Web/PWA = IDB 唯一事实源，不存在双源可切。
 * 2) fresh/空库判据只能当 **没有任何可变内容**：无自定义 deck/word、无 overlay、
 *    无 pack/pack-item/content-reject、无内容 meta、无 states/plans；仅内置可再生正文。
 *    任何非空 IDB 内容都走迁移；**绝不**通过清空 content_kv 再标 done 来"初始化"。
 * 3) 迁移成功判据：IDB 内容快照（entity 集合 + kind + 内容 hash）与 content_kv live 集合
 *    一致（含差集删除），否则 failed 并保持 idb（不能只凭写源成功）。
 * 4) v15 running 时 getContentWriteSource 仍 idb（旧 0.14 sqlite+ready 基线除外）；
 *    完成 marker 双写 SQLite + IDB，读以 SQLite 为准。
 * 5) 失败保持 IDB 可读 + 明确 diag；可重入、kill 后重跑；不阻塞首屏（AppShell 延迟触发）。
 * ========================================================================== */

/** v15 迁移结果事件（AppShell 派发，UI 只读展示；不含任何切换入口） */
export const CONTENT_SOURCE_V15_EVENT = 'momo:content-source-v15'

export interface EnsureContentSourceV15Result {
  ok: boolean
  /** 迁移后实际生效的内容写源 */
  source: ContentWriteSource
  skipped?: 'non-native' | 'already-done' | 'emergency-idb'
  from?: ContentMigrationV15From
  migrated?: boolean
  written?: number
  tombstoned?: number
  error?: string
  code?: string
  needsRerun?: boolean
}

const V15_BUILTIN_DECK_IDS = new Set(DECK_SOURCES.map((source) => source.deckId))

/** 内置 deck 行（正文来自打包资源/IDB seed，可再生产，不算「可变内容」） */
function isRegenerableBuiltinDeckRow(row: ContentWriteInput): boolean {
  if (row.kind !== 'deck') return false
  const keyId = row.key.startsWith('deck:') ? row.key.slice('deck:'.length) : ''
  if (V15_BUILTIN_DECK_IDS.has(keyId)) return true
  try {
    const deck = JSON.parse(row.json) as { id?: string; builtinKey?: string; source?: string }
    if (deck.builtinKey) return true
    if (deck.source === 'builtin') return true
    return Boolean(deck.id && V15_BUILTIN_DECK_IDS.has(deck.id))
  } catch {
    return false
  }
}

/** fresh 判据（内容部分）：计划里没有任何可变内容（overlay/meta/pack/自定义 deck 都算可变） */
function planHasMutableContent(planRows: readonly ContentWriteInput[]): boolean {
  return planRows.some((row) => !isRegenerableBuiltinDeckRow(row))
}

async function readIdbMutableFactCounts(): Promise<{ states: number; plans: number }> {
  const db = getDb()
  const [states, plans] = await Promise.all([db.states.count(), db.plans.count()])
  return { states, plans }
}

/** content_kv 全量 live 行（分页，含 tombstone 过滤；0.15 parity/差集用） */
async function snapshotLiveContentKv(): Promise<Map<string, ContentKvRow>> {
  const live = new Map<string, ContentKvRow>()
  for (let offset = 0, page = 0; page < 10_000; page += 1) {
    const result = await listContentRowsPage({ offset, limit: 1000, includeDeleted: false, orderBy: 'key' })
    if (!result.ok) throw new Error(result.error ?? '读取 content_kv 失败')
    for (const row of result.rows) if (row.deleted === 0) live.set(row.key, row)
    if (!result.hasMore || result.rows.length === 0) return live
    offset += result.rows.length
  }
  throw new Error('content_kv 全量分页超出上限')
}

/** 差集 tombstone：content_kv live 但不在 IDB 快照实体集合的 key → 让 live 集合与 IDB 快照一致（含删除） */
async function pruneContentKvToExpectedSet(expected: ReadonlyMap<string, ContentWriteInput>): Promise<number> {
  const live = await snapshotLiveContentKv()
  const stale: ContentWriteInput[] = []
  for (const [key, row] of live) if (!expected.has(key)) stale.push({ key, kind: row.kind, json: 'null', deleted: true })
  for (let i = 0; i < stale.length; i += CONTENT_WRITE_CHUNK) {
    const result = await writeContentRows(stale.slice(i, i + CONTENT_WRITE_CHUNK))
    if (!result.ok) throw new Error(result.error ?? '清理 content_kv 差集失败')
  }
  return stale.length
}

/** Lead 规则 3：content_kv live 集合必须与 IDB 内容快照逐 key（kind + 内容 hash）一致，且无多余行 */
async function verifyContentKvParityWithPlan(planRows: readonly ContentWriteInput[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const expected = new Map(planRows.map((row) => [row.key, row] as const))
  const live = await snapshotLiveContentKv()
  for (const [key, row] of expected) {
    const stored = live.get(key)
    if (!stored) return { ok: false, error: `content_kv 缺少 IDB 快照行：${key}` }
    if (stored.kind !== row.kind) return { ok: false, error: `content_kv kind 不一致：${key}（实际 ${stored.kind}/期望 ${row.kind}）` }
    const storedHash = hashJson(stored.json)
    const expectedHash = hashJson(row.json)
    if (storedHash === null || expectedHash === null || storedHash !== expectedHash) return { ok: false, error: `content_kv 内容 hash 不一致：${key}` }
  }
  for (const key of live.keys()) if (!expected.has(key)) return { ok: false, error: `content_kv 存在 IDB 快照之外的 live 行：${key}` }
  if (live.size !== expected.size) return { ok: false, error: `content_kv live 行数与 IDB 快照不一致（${live.size}/${expected.size}）` }
  return { ok: true }
}

/** kill/中断遗留的 0.14 running 状态收尾：标 failed，避免旧 ready 门禁误判 */
async function reconcileLegacyRunningContentMigration(): Promise<void> {
  const state = await getContentMigrationState()
  if (state?.status !== 'running') return
  await getDb().meta.put({
    key: CONTENT_MIGRATION_STATE_KEY,
    value: { ...state, status: 'failed', error: '迁移中断（running 未完成），0.15 将重跑', at: Date.now() },
    updatedAt: Date.now(),
  })
  if ((await getContentWriteSource()) === 'sqlite') await persistContentWriteSource('idb').catch(() => undefined)
}

/**
 * 0.15：原生启动时确保内容事实源 = SQLite（幂等、锁内、可重入、kill 后重跑）。
 * 路由：
 * A. v15 done → 直接 sqlite（幂等）
 * B. 旧 0.14 已是 sqlite + migrationState ready → 直接标 done（kv 已是事实源，不做 IDB parity）
 * C. 无任何可变内容（fresh/空库，且无 states/plans）→ done + sqlite（content_kv 可为空；绝不先清 kv）
 * D. 旧 idb / 0.14 ready 待切 / 中断重跑 → preBackup → shadow/formal（IDB 指纹守卫）→ 差集 + parity → finalize → 切 sqlite → done
 * 失败：保持 idb（旧 0.14 sqlite 基线保持 sqlite），写 v15 failed 状态 + 明确 code/needsRerun。
 */
/** 0.15 P1-1：IDB 里是否还有不可再生的可变内容（防止 legacy sqlite 的 kv 被清空后直接 done） */
async function countIdbMutableContent(): Promise<number> {
  const db = getDb()
  const [decks, words, packs, packItems, rejects] = await Promise.all([
    db.decks.toArray(),
    db.words.toArray(),
    db.packs.count(),
    db.packItems.count(),
    db.contentRejects.count(),
  ])
  const builtinDeckIds = new Set(decks.filter((deck) => Boolean(deck.builtinKey) || deck.source === 'builtin' || (DECK_SOURCES as readonly { deckId: string }[]).some((s) => s.deckId === deck.id)).map((deck) => deck.id))
  const customDecks = decks.filter((deck) => !builtinDeckIds.has(deck.id)).length
  const customWords = words.filter((word) => !builtinDeckIds.has(word.deckId) || word.custom === true).length
  const overlays = words.filter((word) => builtinDeckIds.has(word.deckId) && Object.keys(wordOverlayOf(word as unknown as Record<string, unknown>)).length > 0).length
  return customDecks + customWords + packs + packItems + rejects + overlays
}

/**
 * 0.15 迁移前补齐 0.14 遗留标记：内置 deck 中不在打包词表的词 = 用户后加词，
 * 标记 custom=true，避免快照把它们误当内置正文而漏迁移。
 */
export async function backfillLegacyCustomBuiltinWordsForV15(): Promise<number> {
  const db = getDb()
  let marked = 0
  for (const deckId of BUILTIN_DECK_IDS) {
    const source = DECK_SOURCES.find((item) => item.deckId === deckId)
    if (!source) continue
    const words = await db.words.where('deckId').equals(deckId).toArray()
    if (words.length === 0) continue
    let builtinIds = new Set<string>()
    try {
      const parsed = parseBuiltinDeckFile(await source.load())
      builtinIds = new Set(parsed.words.map((word) => word.id))
    } catch {
      continue
    }
    const extras = words.filter((word) => !builtinIds.has(word.id) && (word as unknown as { custom?: boolean }).custom !== true)
    if (extras.length === 0) continue
    await db.words.bulkPut(extras.map((word) => ({ ...word, custom: true })) as never)
    marked += extras.length
  }
  return marked
}

/** v15 迁移成功/缓存重建成功后标记 IDB 内容 cache 已就绪，避免每次启动重复重建并长时间持锁 */
async function markContentCacheReady(): Promise<void> {
  const generation = await getDataEpoch().catch(() => 0)
  await writeIdbCacheMeta({ generation, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false, rebuiltAt: Date.now() }).catch(() => undefined)
}

export async function ensureContentSourceV15(opts: {
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  shouldAbort?: () => boolean
} = {}): Promise<EnsureContentSourceV15Result> {
  if (!isNativeContentSqliteRuntime()) return { ok: true, source: 'idb', skipped: 'non-native' }
  return withDataWriteLock(async () => {
    let attempt = ((await getContentMigrationV15State())?.attempt ?? 0) + 1
    let from: ContentMigrationV15From | undefined
    let lastWritten: number | undefined
    const fail = async (code: string, error: string, extra: Partial<ContentMigrationV15State> = {}): Promise<EnsureContentSourceV15Result> => {
      // 失败保持可用写源：旧 0.14 已切 sqlite 的基线保持 sqlite（避免用陈旧 IDB cache 覆盖事实源），其余保持 idb
      const legacy = await getLegacyContentWriteSource().catch(() => 'idb' as ContentWriteSource)
      await persistContentWriteSource(legacy).catch(() => undefined)
      await writeContentMigrationV15State({
        status: 'failed',
        at: Date.now(),
        attempt,
        ...(from ? { from } : {}),
        error,
        code,
        ...(extra.needsRerun ? { needsRerun: true } : {}),
      }).catch(() => undefined)
      return {
        ok: false,
        source: legacy,
        ...(from ? { from } : {}),
        error,
        code,
        ...(lastWritten !== undefined ? { written: lastWritten } : {}),
        ...(extra.needsRerun ? { needsRerun: true } : {}),
      }
    }
    try {
      // A) 已完成
      if (await isContentMigrationV15Done()) {
        await persistContentWriteSource('sqlite').catch(() => undefined)
        await markContentCacheReady()
        return { ok: true, source: 'sqlite', skipped: 'already-done' }
      }
      // emergency rollback（内部/调试）优先：不自动迁移
      if (await isContentSourceEmergencyIdb()) return { ok: true, source: 'idb', skipped: 'emergency-idb' }
      // schema v3 门禁（不 mock）：低/高版本直接失败，不迁移
      const schema = await assertContentSchemaVersion()
      if (!schema.ok) return fail('E_CONTENT_SCHEMA', schema.error ?? `SQLite schema v${schema.userVersion} 不满足 content_kv v3`)
      await writeContentMigrationV15State({ status: 'running', at: Date.now(), attempt })
      await reconcileLegacyRunningContentMigration()
      const legacySource = await getLegacyContentWriteSource()
      const migration14 = await getContentMigrationState()
      // B) 旧 0.14 已是 sqlite + ready → kv 已是事实源，直接标 done（无需再迁移 IDB cache）
      if (legacySource === 'sqlite') {
        from = 'legacy-sqlite-ready'
        if (migration14?.status !== 'ready') {
          return fail('E_V15_LEGACY_STATE_MISMATCH', `旧 0.14 内容写源已是 sqlite，但迁移状态不是 ready（${migration14?.status ?? 'null'}）；保持 sqlite 不迁移，请诊断`)
        }
        const counts = await readContentCounts().catch(() => null)
        if (!counts) return fail('E_V15_LEGACY_COUNTS', '旧 0.14 sqlite 基线无法读取 content_kv counts；保持原写源并需诊断')
        // C3：旧 0.14 ready 但记录过 IDB 指纹时，先确认 IDB 内容未变化；变了必须重跑迁移
        if (migration14.idbFingerprint) {
          const currentFingerprint = await computeContentIdbFingerprint()
          if (!isSameContentIdbFingerprint(migration14.idbFingerprint, currentFingerprint)) {
            return fail('E_CONTENT_CHANGED', '旧 0.14 sqlite 基线记录的 IDB 指纹已变化，需要重跑迁移', { needsRerun: true })
          }
        }
        // P1-1：legacy kv 被清空/损坏时不能直接 done+sqlite；若 IDB 仍有可变内容则拒绝
        const liveKv = Math.max(0, Number(counts.total) - Number(counts.deleted))
        if (liveKv <= 0) {
          const idbMutable = await countIdbMutableContent().catch(() => 0)
          if (idbMutable > 0) {
            return fail('E_V15_LEGACY_KV_EMPTY', `旧 0.14 sqlite 基线 content_kv 为空，但 IDB 仍有 ${idbMutable} 条可变内容；拒绝标 done（请恢复备份/诊断）`)
          }
        }
        await persistContentWriteSource('sqlite').catch(() => undefined)
        await getDb().meta.delete(CONTENT_KV_STALE_KEY).catch(() => undefined)
        await writeContentMigrationV15State({ status: 'done', at: Date.now(), from, attempt, finishedAt: Date.now(), counts: { total: counts.total, revision: counts.revision } })
        await markContentCacheReady()
        return { ok: true, source: 'sqlite', from }
      }
      // C) 锁内一次快照：先补齐 0.14 遗留自定义词标记，再计算 IDB 指纹 + 迁移计划
      await backfillLegacyCustomBuiltinWordsForV15().catch(() => 0)
      const fingerprintBefore = await computeContentIdbFingerprint()
      const batches = await buildContentMigrationPlan({ ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}) })
      const planRows = batches.flatMap((batch) => batch.rows)
      const fingerprintAfterPlan = await computeContentIdbFingerprint()
      if (!isSameContentIdbFingerprint(fingerprintBefore, fingerprintAfterPlan)) {
        return fail('E_CONTENT_CHANGED', '迁移快照期间 IDB 内容发生变化，需要重跑', { needsRerun: true })
      }
      const countsBefore = await readContentCounts().catch(() => null)
      const kvLiveCount = countsBefore ? Math.max(0, countsBefore.total - countsBefore.deleted) : 0
      const idbFacts = await readIdbMutableFactCounts()
      const freshish = !planHasMutableContent(planRows) && idbFacts.states === 0 && idbFacts.plans === 0
      if (freshish) {
        // 数据保护：IDB 已无可变内容但 content_kv 仍有 live 行 → 可能只剩内容库一份数据，禁止清空后标 done
        if (kvLiveCount > 0) {
          return fail('E_V15_KV_NOT_EMPTY', `IDB 无可变内容但 content_kv 仍有 ${kvLiveCount} 条 live 行；拒绝清空 content_kv 并标 done（请先恢复备份/诊断）`)
        }
        from = 'fresh'
        await persistContentWriteSource('sqlite').catch(() => undefined)
        await writeContentMigrationV15State({ status: 'done', at: Date.now(), from, attempt, finishedAt: Date.now(), counts: { total: 0, revision: countsBefore?.revision ?? 0, idbContent: 0 } })
        await markContentCacheReady()
        return { ok: true, source: 'sqlite', from, migrated: true, written: 0 }
      }
      // D) 有可变内容：preBackup → shadow/formal（复用批次 + 计划时 IDB 指纹守卫）
      const result = await runContentMigrationFormalInner({
        ...(opts.preBackup ? { preBackup: opts.preBackup } : {}),
        ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
        batches,
        expectedFingerprint: fingerprintAfterPlan,
      })
      lastWritten = result.written
      from = 'legacy-idb'
      if (!result.ok) {
        return fail(result.needsRerun ? 'E_CONTENT_CHANGED' : 'E_V15_MIGRATION_FAILED', result.error ?? '内容迁移失败', { needsRerun: result.needsRerun })
      }
      // E) 成功判据：先差集补 tombstone，再全量 parity（集合/kind/hash，含删除），否则 failed 保持 idb
      const expected = new Map(planRows.map((row) => [row.key, row] as const))
      const tombstoned = await pruneContentKvToExpectedSet(expected)
      const parity = await verifyContentKvParityWithPlan(planRows)
      if (!parity.ok) return fail('E_V15_PARITY', `迁移后 content_kv 与 IDB 内容不一致：${parity.error}`, { needsRerun: true })
      // 覆盖自检（B-D1 门禁；只在这里由数据层置位，不对外暴露切换）
      const finalized = await finalizeContentWriteCoverage()
      if (!finalized.ok) return fail('E_V15_FINALIZE', `覆盖自检失败：${finalized.error ?? '未知错误'}`)
      const counts = await readContentCounts().catch(() => null)
      await persistContentWriteSource('sqlite').catch(() => undefined)
      // P1-2：v15 成功即已用 IDB 内容重建 kv，旧 stale 标记必须清除，否则备份/恢复会被门禁拒绝
      await getDb().meta.delete(CONTENT_KV_STALE_KEY).catch(() => undefined)
      await writeContentMigrationV15State({ status: 'done', at: Date.now(), from, attempt, finishedAt: Date.now(), counts: { total: counts?.total, revision: counts?.revision, idbContent: planRows.length } })
      await markContentCacheReady()
      return { ok: true, source: 'sqlite', from, migrated: true, written: result.written, tombstoned }
    } catch (error) {
      return fail('E_V15_MIGRATION_FAILED', errorMessage(error), { needsRerun: true })
    }
  })
}

/** 0.15：v15 迁移状态读（UI/诊断只读；不含切换入口） */
export async function getContentSourceV15Status(): Promise<{ native: boolean; source: ContentWriteSource; state: ContentMigrationV15State | null }> {
  return {
    native: isNativeContentSqliteRuntime(),
    source: await getContentWriteSource().catch(() => 'idb' as ContentWriteSource),
    state: await getContentMigrationV15State().catch(() => null),
  }
}


/** R4：restore 前等待内容迁移静止；running 最多等 timeoutMs，超时明确拒绝 */
export async function waitForContentMigrationQuiescent(opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; state: string; error?: string }> {
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 90_000)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { hasDurableContentMigrationV15Marker } = await import('./content-write-source')
    const durable = await hasDurableContentMigrationV15Marker().catch(() => false)
    const state = durable ? 'done' : ((await getContentMigrationV15State().catch(() => null))?.status ?? 'idle')
    if (state !== 'running') return { ok: true, state }
    if (Date.now() > deadline) return { ok: false, state, error: '内容迁移进行中，请稍后再恢复（迁移完成前换库会被覆盖）' }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
