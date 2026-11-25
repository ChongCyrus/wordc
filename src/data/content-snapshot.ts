/** 0.12：内容快照索引 + 增量包（只索引非进度内容，不含实体正文） */
import { fnv1a64Hex } from './checksum'
import { getDb } from './db'
import { DECK_SOURCES } from './builtin/deck-sources'
import { withDataWriteLock } from './write-lock'
import { isSqliteAvailable } from './native-sqlite'
import type { ContentKind, ContentKvRow, ContentWriteInput } from './content-store'

export const CONTENT_SNAPSHOT_FORMAT = 'momo-content-snapshot-manifest' as const
export const CONTENT_INCREMENT_FORMAT = 'momo-content-increment' as const
export const CONTENT_SNAPSHOT_VERSION = 1
export const CONTENT_META_PREFIXES = ['derivationMap:', 'userNote:', 'userMnemonic:', 'rootEtymology:'] as const

export interface ContentEntry {
  type: string
  key: string
  hash: string
  updatedAt: number
}

export interface ContentSnapshotManifest {
  format: typeof CONTENT_SNAPSHOT_FORMAT
  formatVersion: 1
  snapshotId: string
  revision: number
  createdAt: number
  counts: Record<string, number>
  entries: ContentEntry[]
  /** 0.12：实体口径版本；旧基线缺省视为 0 */
  entitySetVersion?: number
}

export interface ContentEntity extends ContentEntry {
  data: unknown
}

export interface ContentTombstone {
  type: string
  key: string
}

export interface ContentIncrementPackage {
  format: typeof CONTENT_INCREMENT_FORMAT
  formatVersion: 1
  baseSnapshotId: string
  baseRevision: number
  newRevision: number
  snapshotId: string
  entities: ContentEntity[]
  tombstones: ContentTombstone[]
  checksum: string
  /** 0.13：log=事件日志校验通过；diff=快照 diff */
  source?: 'log' | 'diff'
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`
}

export function hashContentValue(value: unknown): string {
  return hashOf(value)
}

function hashOf(value: unknown): string {
  return fnv1a64Hex(stable(value))
}

function updatedAtOf(value: unknown): number {
  const object = value as { updatedAt?: unknown; createdAt?: number; at?: unknown } | null
  const number = Number(object?.updatedAt ?? object?.createdAt ?? object?.at ?? 0)
  return Number.isFinite(number) ? number : 0
}

export const WORD_OVERLAY_FIELDS = [
  'maimemoVocId', 'userNotes', 'userMnemonics', 'hiddenMnemonicKeys', 'derivationMap',
  'ncMeaningIds', 'rootMnemonic', 'rareMeaningIds', 'senseMnemonics', 'rareCoreSenses',
  'rareMarkCheckedAt', 'rareMarkVersion', 'coreSenseExamples', 'coreSensePhrases',
  'coreSenseOverview', 'rootEtymology', 'rootEtymologyCheckedAt', 'rootEtymologyVersion',
] as const

export function wordOverlayOf(word: Record<string, unknown>): Record<string, unknown> {
  const overlay: Record<string, unknown> = {}
  for (const field of WORD_OVERLAY_FIELDS) if (word[field] !== undefined) overlay[field] = word[field]
  if (typeof word.updatedAt === 'number') overlay.updatedAt = word.updatedAt
  return overlay
}

/**
 * 0.15：content_kv 是否为当前平台的唯一事实源。
 * 权威判定统一走 `getContentWriteSource()`（task-293 契约）：
 * - 非 native content runtime（Web/PWA/无 sqlite）→ 'idb'（即使 settings 残留 sqlite 也不认）；
 * - native：v15 done（或旧 0.14 已是 sqlite 的迁移输入）→ 'sqlite'，紧急回退 → 'idb'。
 * 这里再叠加 isSqliteAvailable() 兜底：没有原生 SQLite 的平台永远只认 IDB。
 */
export async function isContentKvFactSource(): Promise<boolean> {
  if (!isSqliteAvailable()) return false
  const { getContentWriteSource } = await import('./content-write-source')
  return (await getContentWriteSource()) === 'sqlite'
}

/**
 * 0.15：备份/恢复是否从 content_kv 读取事实源。
 * 不再依赖旧 contentMigrationState==='ready'；但 content_kv 被标记 stale（导入回退遗留）时仍拒绝，
 * fail-closed 抛 E_CONTENT_KV_STALE（不能回落 IDB cache 生成备份，否则会漏/复活内容）。
 */
async function isContentKvSnapshotSource(): Promise<boolean> {
  if (!(await isContentKvFactSource())) return false
  const { CONTENT_KV_STALE_KEY } = await import('./content-store')
  if (await getDb().meta.get(CONTENT_KV_STALE_KEY)) {
    throw new Error('E_CONTENT_KV_STALE: content_kv 已被标记 stale（导入回退遗留），拒绝从内容库生成备份或恢复；请先清理过期内容库')
  }
  return true
}

/** 恢复成功后 content_kv 已是新事实源：清掉导入回退遗留的 stale 标记（best-effort） */
async function clearContentKvStaleAfterRestore(): Promise<void> {
  try {
    const { CONTENT_KV_STALE_KEY } = await import('./content-store')
    await getDb().meta.delete(CONTENT_KV_STALE_KEY)
    await getDb().meta.delete('contentWriteSourceResetForImport')
  } catch {
    // 清理失败不改变恢复结果（下次备份前仍会 fail-closed）
  }
}

/** content_kv kind → 快照 type（与 IDB 扫描口径一致，保证同一内容 hash/snapshotId 相同） */
const CONTENT_SNAPSHOT_TYPE_BY_KIND: Record<string, string> = {
  deck: 'decks',
  word: 'words',
  'word-overlay': 'wordOverlay',
  pack: 'packs',
  'pack-item': 'packItems',
  'content-reject': 'contentRejects',
  meta: 'meta',
}

/** content_kv live 行 → 快照索引项；未知 kind / 非内容 meta / null 实体跳过；坏 JSON fail-closed */
function contentKvRowToSnapshotEntry(row: ContentKvRow): ContentEntry | null {
  const type = CONTENT_SNAPSHOT_TYPE_BY_KIND[row.kind]
  if (!type) return null
  const separator = row.key.indexOf(':')
  if (separator <= 0) return null
  const key = row.key.slice(separator + 1)
  if (key.length === 0) return null
  if (type === 'meta' && !isContentMetaKey(key)) return null
  let value: unknown
  try {
    value = JSON.parse(row.json)
  } catch {
    throw new Error(`content_kv 行 JSON 损坏：${row.key}`)
  }
  if (type !== 'meta' && (value === null || value === undefined)) return null
  return { type, key, hash: hashContentValue(value), updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : updatedAtOf(value) }
}

/**
 * 0.14：从 content_kv 分页构建快照（source=sqlite 且迁移 ready）。
 * 只读 live 行（deleted=0），hash=hashContentValue(JSON.parse(json))，updatedAt 用行值；
 * 不读 IDB cache。删除行不进入 live snapshot，其增量 tombstone 走现有链逻辑。
 */
async function buildContentSnapshotFromContentKv(opts: BuildContentSnapshotOptions): Promise<ContentSnapshotManifest> {
  const rows = await listAllContentKvRows()
  const entries: ContentEntry[] = []
  const counts: Record<string, number> = {}
  for (let index = 0; index < rows.length; index += 1) {
    if (index % 200 === 0 && opts.shouldAbort?.()) throw new Error('E_ABORTED: 内容快照已取消')
    const row = rows[index]!
    if (row.deleted !== 0) continue
    const entry = contentKvRowToSnapshotEntry(row)
    if (!entry) continue
    entries.push(entry)
    counts[entry.type] = (counts[entry.type] ?? 0) + 1
    if ((index + 1) % 200 === 0) opts.onProgress?.({ phase: 'scan', type: 'content_kv', done: index + 1 })
  }
  entries.sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key))
  const snapshotId = hashOf(entries.map(({ type, key, hash }) => ({ type, key, hash })))
  const manifest: ContentSnapshotManifest = {
    format: CONTENT_SNAPSHOT_FORMAT,
    formatVersion: CONTENT_SNAPSHOT_VERSION,
    snapshotId,
    revision: Math.max(0, Math.floor(opts.revision ?? 1)),
    createdAt: opts.now ?? Date.now(),
    counts,
    entries,
    entitySetVersion: 1,
  }
  opts.onProgress?.({ phase: 'done', done: entries.length })
  return manifest
}

export interface BuildContentSnapshotOptions {
  batchSize?: number
  shouldAbort?: () => boolean
  onProgress?: (progress: { phase: 'scan' | 'done'; type?: string; done: number }) => void
  revision?: number
  now?: number
  /** 默认 false：内置词库 words 可再生，不进快照正文 */
  includeBuiltinWords?: boolean
}

/** 分页扫描非进度内容 → 索引；只保留索引（不含实体正文） */
export async function buildContentSnapshot(opts: BuildContentSnapshotOptions = {}): Promise<ContentSnapshotManifest> {
  if (opts.shouldAbort?.()) throw new Error('E_ABORTED: 内容快照已取消')
  // 0.14：sqlite 写源 + 迁移 ready 时以 content_kv 为事实源（IDB 只是 cache）
  if (await isContentKvSnapshotSource()) return buildContentSnapshotFromContentKv(opts)
  const db = getDb()
  const batchSize = Math.max(50, Math.min(1000, Math.floor(opts.batchSize ?? 200)))
  const entries: ContentEntry[] = []
  const counts: Record<string, number> = {}
  const add = (type: string, key: string, value: unknown) => {
    entries.push({ type, key, hash: hashOf(value), updatedAt: updatedAtOf(value) })
    counts[type] = (counts[type] ?? 0) + 1
  }
  const scanTable = async (type: string, table: { toArray: () => Promise<unknown[]> }, keyOf: (row: unknown) => string) => {
    const rows = await table.toArray()
    for (let i = 0; i < rows.length; i += batchSize) {
      if (opts.shouldAbort?.()) throw new Error('E_ABORTED: 内容快照已取消')
      for (const row of rows.slice(i, i + batchSize)) add(type, keyOf(row), row)
      opts.onProgress?.({ phase: 'scan', type, done: Math.min(i + batchSize, rows.length) })
    }
  }
  await scanTable('decks', db.decks, (row) => String((row as { id: string }).id))
  if (opts.includeBuiltinWords !== true) {
    const decks = await db.decks.toArray()
    const knownBuiltinIds = new Set(DECK_SOURCES.map((source) => source.deckId))
    const builtinDeckIds = new Set(decks.filter((deck) => Boolean(deck.builtinKey) || deck.source === 'builtin' || knownBuiltinIds.has(deck.id)).map((deck) => deck.id))
    const words = await db.words.toArray()
    for (let i = 0; i < words.length; i += batchSize) {
      if (opts.shouldAbort?.()) throw new Error('E_ABORTED: 内容快照已取消')
      for (const row of words.slice(i, i + batchSize)) {
        const customBuiltinWord = builtinDeckIds.has(row.deckId) && (row as unknown as { custom?: boolean }).custom === true
        if (builtinDeckIds.has(row.deckId) && !customBuiltinWord) {
          const overlay = wordOverlayOf(row as unknown as Record<string, unknown>)
          if (Object.keys(overlay).length > 0) add('wordOverlay', String(row.id), overlay)
        } else {
          add('words', String(row.id), row)
        }
      }
      opts.onProgress?.({ phase: 'scan', type: 'words', done: Math.min(i + batchSize, words.length) })
    }
  } else {
    await scanTable('words', db.words, (row) => String((row as { id: string }).id))
  }
  await scanTable('packs', db.packs, (row) => String((row as { id: string }).id))
  await scanTable('packItems', db.packItems, (row) => String((row as { id: string }).id))
  await scanTable('contentRejects', db.contentRejects, (row) => String((row as { id: string }).id))
  const metaRows = (await db.meta.toArray()).filter((row) => CONTENT_META_PREFIXES.some((prefix) => row.key.startsWith(prefix)))
  for (const row of metaRows) add('meta', row.key, row.value)
  entries.sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key))
  const snapshotId = hashOf(entries.map(({ type, key, hash }) => ({ type, key, hash })))
  const manifest: ContentSnapshotManifest = {
    format: CONTENT_SNAPSHOT_FORMAT,
    formatVersion: CONTENT_SNAPSHOT_VERSION,
    snapshotId,
    revision: Math.max(0, Math.floor(opts.revision ?? 1)),
    createdAt: opts.now ?? Date.now(),
    counts,
    entries,
    entitySetVersion: 1,
  }
  opts.onProgress?.({ phase: 'done', done: entries.length })
  return manifest
}

export interface ContentDelta {
  entities: Array<Omit<ContentEntity, 'data'>>
  tombstones: ContentTombstone[]
}

/** 纯计算：基线 → 当前 的新增/修改/删除 */
export function diffContentEntries(base: readonly ContentEntry[], current: readonly ContentEntry[]): ContentDelta {
  const baseMap = new Map(base.map((entry) => [`${entry.type}\u0000${entry.key}`, entry]))
  const currentMap = new Map(current.map((entry) => [`${entry.type}\u0000${entry.key}`, entry]))
  const entities: ContentDelta['entities'] = []
  for (const [id, entry] of currentMap) {
    const previous = baseMap.get(id)
    if (!previous || previous.hash !== entry.hash) entities.push(entry)
  }
  const tombstones: ContentTombstone[] = []
  for (const [id, entry] of baseMap) if (!currentMap.has(id)) tombstones.push({ type: entry.type, key: entry.key })
  return { entities, tombstones }
}

export interface BuildContentIncrementOptions {
  entities?: Array<{ type: string; key: string; data: unknown }>
  now?: number
  revisionStep?: number
}

/** 生成增量包；只接受与基线 snapshotId/revision 匹配的链；不推进 revision 由上层决定 */
export function buildContentIncrement(
  base: ContentSnapshotManifest,
  current: ContentSnapshotManifest,
  opts: BuildContentIncrementOptions = {},
): ContentIncrementPackage | { needsFullSnapshot: true; reason: string } {
  if (current.snapshotId === base.snapshotId) {
    return { needsFullSnapshot: true, reason: '内容无变化，无需增量' }
  }
  const delta = diffContentEntries(base.entries, current.entries)
  const entityByKey = new Map((opts.entities ?? []).map((entity) => [`${entity.type}\u0000${entity.key}`, entity]))
  const entities: ContentEntity[] = delta.entities.map((entry) => {
    const body = entityByKey.get(`${entry.type}\u0000${entry.key}`)
    return { ...entry, data: body?.data ?? null }
  })
  const baseRevision = base.revision
  const newRevision = baseRevision + Math.max(1, Math.floor(opts.revisionStep ?? 1))
  const checksumPayload = {
    baseSnapshotId: base.snapshotId,
    baseRevision,
    newRevision,
    snapshotId: current.snapshotId,
    entities: entities.map(({ type, key, hash }) => ({ type, key, hash })),
    tombstones: delta.tombstones,
  }
  return {
    format: CONTENT_INCREMENT_FORMAT,
    formatVersion: CONTENT_SNAPSHOT_VERSION,
    baseSnapshotId: base.snapshotId,
    baseRevision,
    newRevision,
    snapshotId: current.snapshotId,
    entities,
    tombstones: delta.tombstones,
    checksum: `fnv1a64:${hashOf(checksumPayload)}`,
  }
}

/** 校准增量链：基线 ID/revision/checksum 不一致 → 建议完整快照 */
export function validateContentIncrement(
  pkg: ContentIncrementPackage,
  base: ContentSnapshotManifest,
): { ok: true } | { ok: false; needsFullSnapshot: true; reason: string } {
  if (pkg.format !== CONTENT_INCREMENT_FORMAT || pkg.formatVersion !== CONTENT_SNAPSHOT_VERSION) {
    return { ok: false, needsFullSnapshot: true, reason: '增量格式/version 不支持' }
  }
  if (pkg.baseSnapshotId !== base.snapshotId) return { ok: false, needsFullSnapshot: true, reason: 'baseSnapshotId 与当前基线不一致' }
  if (pkg.baseRevision !== base.revision) return { ok: false, needsFullSnapshot: true, reason: 'baseRevision 与当前 revision 不一致' }
  if (pkg.newRevision <= pkg.baseRevision) return { ok: false, needsFullSnapshot: true, reason: 'newRevision 未推进' }
  const payload = {
    baseSnapshotId: pkg.baseSnapshotId,
    baseRevision: pkg.baseRevision,
    newRevision: pkg.newRevision,
    snapshotId: pkg.snapshotId,
    entities: pkg.entities.map(({ type, key, hash }) => ({ type, key, hash })),
    tombstones: pkg.tombstones,
  }
  if (pkg.checksum !== `fnv1a64:${hashOf(payload)}`) return { ok: false, needsFullSnapshot: true, reason: '增量 checksum 不匹配' }
  return { ok: true }
}

/** 按快照索引导出实体正文（分页/可取消）；只读，不写库 */
export async function exportContentEntities(
  entries: readonly ContentEntry[],
  opts: { shouldAbort?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ContentEntity[]> {
  // 0.14：sqlite 写源 + 迁移 ready 时正文以 content_kv 为准（contentGet 批量 ≤500），不读 IDB cache
  if (await isContentKvSnapshotSource()) return exportContentEntitiesFromContentKv(entries, opts)
  const db = getDb()
  const out: ContentEntity[] = []
  const batchSize = 100
  for (let i = 0; i < entries.length; i += batchSize) {
    if (opts.shouldAbort?.()) throw new Error('E_ABORTED: 内容导出已取消')
    const page = entries.slice(i, i + batchSize)
    const byType = new Map<string, string[]>()
    for (const entry of page) {
      const list = byType.get(entry.type) ?? []
      list.push(entry.key)
      byType.set(entry.type, list)
    }
    const bodies = new Map<string, unknown>()
    const getRows = async (type: string, table: { bulkGet: (keys: string[]) => Promise<unknown[]> }) => {
      const keys = byType.get(type) ?? []
      const rows = await table.bulkGet(keys)
      rows.forEach((row, index) => { if (row) bodies.set(`${type}\u0000${keys[index]}`, row) })
    }
    await getRows('decks', db.decks)
    await getRows('words', db.words)
    await getRows('packs', db.packs)
    await getRows('packItems', db.packItems)
    await getRows('contentRejects', db.contentRejects)
    const overlayKeys = byType.get('wordOverlay') ?? []
    if (overlayKeys.length > 0) {
      const rows = await db.words.bulkGet(overlayKeys)
      rows.forEach((row, index) => { if (row) bodies.set(`wordOverlay\u0000${overlayKeys[index]}`, wordOverlayOf(row as unknown as Record<string, unknown>)) })
    }
    const metaKeys = byType.get('meta') ?? []
    if (metaKeys.length > 0) {
      const rows = await db.meta.bulkGet(metaKeys)
      rows.forEach((row, index) => { if (row) bodies.set(`meta\u0000${metaKeys[index]}`, row.value) })
    }
    for (const entry of page) {
      const data = bodies.get(`${entry.type}\u0000${entry.key}`) ?? null
      out.push({ ...entry, data })
    }
    opts.onProgress?.(Math.min(i + batchSize, entries.length), entries.length)
  }
  return out
}

/** 0.14：按 entry type/key → contentGet(content_kv) 批量取正文（≤500/批）；坏 JSON fail-closed */
async function exportContentEntitiesFromContentKv(
  entries: readonly ContentEntry[],
  opts: { shouldAbort?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ContentEntity[]> {
  if (entries.length === 0) return []
  const { sqliteCall } = await import('./native-sqlite')
  const bodies = new Map<string, unknown>()
  const batchSize = 500
  for (let index = 0; index < entries.length; index += batchSize) {
    if (opts.shouldAbort?.()) throw new Error('E_ABORTED: 内容导出已取消')
    const page = entries.slice(index, index + batchSize)
    const keys = page.map((entry) => contentKvKey(entry.type, entry.key))
    const response = await sqliteCall({
      method: 'contentGet' as never,
      payload: { keys },
      timeoutMs: 30_000,
    } as never) as { ok?: boolean; rows?: Array<Record<string, unknown>>; code?: string; message?: string } | null | undefined
    if (!response || response.ok === false) {
      throw new Error(`读取 content_kv 正文失败：${`${response?.code ?? ''} ${response?.message ?? ''}`.trim() || '无响应'}`)
    }
    for (const row of response.rows ?? []) {
      if (!row || typeof row.key !== 'string') continue
      if (Number(row.deleted) === 1) continue // 并发删除：按缺行处理
      const raw = row.json
      if (typeof raw !== 'string') throw new Error(`content_kv 行正文缺失：${row.key}`)
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        throw new Error(`content_kv 行 JSON 损坏：${row.key}`)
      }
      bodies.set(row.key, value)
    }
    opts.onProgress?.(Math.min(index + batchSize, entries.length), entries.length)
  }
  return entries.map((entry) => {
    const key = contentKvKey(entry.type, entry.key)
    return { ...entry, data: bodies.has(key) ? bodies.get(key) : null }
  })
}

export const CONTENT_CHAIN_META_KEY = 'backup.contentChain'

export interface ContentChainState {
  baseSnapshotId: string
  revision: number
  sequence: number
  needsFullSnapshot: boolean
  consecutiveFailures: number
  lastLogSeq?: number
  updatedAt: number
}

export async function getContentChainState(): Promise<ContentChainState | null> {
  const row = await getDb().meta.get(CONTENT_CHAIN_META_KEY)
  return (row?.value as ContentChainState | undefined) ?? null
}

export async function setContentChainState(state: Omit<ContentChainState, 'updatedAt'> & { updatedAt?: number }): Promise<ContentChainState> {
  const next: ContentChainState = { ...state, updatedAt: state.updatedAt ?? Date.now() }
  await getDb().meta.put({ key: CONTENT_CHAIN_META_KEY, value: next, updatedAt: next.updatedAt })
  return next
}

export async function markContentChainFailure(_error: string): Promise<ContentChainState> {
  const current = (await getContentChainState()) ?? { baseSnapshotId: '', revision: 0, sequence: 0, needsFullSnapshot: false, consecutiveFailures: 0, updatedAt: Date.now() }
  const failures = current.consecutiveFailures + 1
  return setContentChainState({ ...current, consecutiveFailures: failures, needsFullSnapshot: failures >= 3 ? true : current.needsFullSnapshot, updatedAt: Date.now() })
}

export async function markContentChainSuccess(input: { baseSnapshotId: string; revision: number; sequence: number }): Promise<ContentChainState> {
  return setContentChainState({ ...input, needsFullSnapshot: false, consecutiveFailures: 0, updatedAt: Date.now() })
}

/** 文件存储抽象（native content-backups/ 由 arch 实现；本轮测试用 mock） */
export interface ContentBackupStorage {
  save(text: string, name: string): Promise<{ ok: boolean; name?: string; error?: string }>
  read(name: string): string | null
  list(): Array<{ name: string; size: number; mtime: number }>
  delete(name: string): boolean
}

export interface ContentBaselineFile {
  format: 'momo-content-baseline'
  formatVersion: 1
  manifest: ContentSnapshotManifest
  entities: ContentEntity[]
  checksum: string
}

export async function buildContentBaselineFile(manifest: ContentSnapshotManifest, opts: { shouldAbort?: () => boolean } = {}): Promise<ContentBaselineFile> {
  const entities = await exportContentEntities(manifest.entries, opts)
  const payload = { snapshotId: manifest.snapshotId, revision: manifest.revision, entities }
  return {
    format: 'momo-content-baseline',
    formatVersion: 1,
    manifest,
    entities,
    checksum: `fnv1a64:${hashOf(payload)}`,
  }
}

export async function saveContentBaselineFile(storage: ContentBackupStorage, file: ContentBaselineFile): Promise<{ ok: boolean; name: string; error?: string }> {
  const name = `content-baseline-${file.manifest.revision}-${file.manifest.snapshotId}.json`
  const result = await storage.save(JSON.stringify(file), name)
  return { ok: result.ok, name: result.name ?? name, ...(result.error ? { error: result.error } : {}) }
}

/** A8：恢复入口持全局写锁；content-backup 等外层已持锁的调用方用 skipWriteLock 避免嵌套死锁 */
export interface ContentRestoreOptions { skipWriteLock?: boolean }

const CONTENT_TABLES = ['decks', 'words', 'packs', 'packItems', 'contentRejects'] as const

function tableOf(db: ReturnType<typeof getDb>, type: string) {
  if (type === 'decks') return db.decks
  if (type === 'words') return db.words
  if (type === 'packs') return db.packs
  if (type === 'packItems') return db.packItems
  if (type === 'contentRejects') return db.contentRejects
  return null
}

/* ------------------------------------------------------------------ *
 * 0.14 恢复 → content_kv 同步（A1-A9）
 *
 * 设计要点：
 * - A1：replaceAll 的旧 key 集合必须全量分页（同一 revision 组可能跨页），不能只读第一页。
 * - A2：tombstone 行沿用原行 / 原始类型的 kind，不再统一写 'meta'。
 * - A3：先按链语义算出最终目标集合（后层 tombstone 删除、后层 entity 重新加回），
 *   再一次性删除不在集合的 key，最后 upsert；IDB 与 content_kv 用同一份最终集合。
 * - A4：base 基线校验 checksum / manifest / revision；不符直接拒绝，不写任何库。
 * - A5：undo 失败不吞，失败信息里带上回滚错误；markContentChainSuccess 只在成功提交后执行，
 *   它自身失败不回滚已提交的数据。
 * - A6：恢复行 updatedAt 保留原值；data 为 null 的实体按 tombstone 跳过（不写 "null" 实体行）。
 * - A7：先算最终集合，再同步 content_kv + IDB；IDB 失败时补偿已写 content_kv（IDB 事务原子）。
 * - A8：多批失败时按写前快照补偿所有「已写 / 已删」key。
 * - A9：只处理内容 key（deck/word/word-overlay/pack/pack-item/content-reject + 内容 meta 前缀），
 *   不碰 learning facts / 非内容 meta。
 * ------------------------------------------------------------------ */

function isContentMetaKey(key: string): boolean {
  return CONTENT_META_PREFIXES.some((prefix) => key.startsWith(prefix))
}

const CONTENT_KIND_BY_TYPE: Record<string, ContentKind> = {
  decks: 'deck',
  words: 'word',
  wordOverlay: 'word-overlay',
  packs: 'pack',
  packItems: 'pack-item',
  contentRejects: 'content-reject',
  meta: 'meta',
}

const CONTENT_KIND_BY_KEY_PREFIX: Record<string, ContentKind> = {
  deck: 'deck',
  word: 'word',
  'word-overlay': 'word-overlay',
  pack: 'pack',
  'pack-item': 'pack-item',
  'content-reject': 'content-reject',
  meta: 'meta',
}

function contentKvKindOfType(type: string): ContentKind | null {
  return CONTENT_KIND_BY_TYPE[type] ?? null
}

function contentKvKindOfKey(key: string): ContentKind | null {
  const separator = key.indexOf(':')
  if (separator <= 0) return null
  return CONTENT_KIND_BY_KEY_PREFIX[key.slice(0, separator)] ?? null
}

function contentEntityId(entity: { type: string; key: string }): string {
  return `${entity.type}\u0000${entity.key}`
}

/** A9：只有 0.12/0.14 定义的内容实体才允许写；非内容 meta 一律拒绝 */
function isContentEntity(entity: ContentEntity): boolean {
  const kind = contentKvKindOfType(entity.type)
  if (!kind) return false
  if (typeof entity.key !== 'string' || entity.key.length === 0) return false
  if (kind === 'meta') return isContentMetaKey(entity.key)
  return true
}

/** A9：content_kv 里只处理内容 key，其它 key 不删不改 */
function isContentKvKey(key: string): boolean {
  const kind = contentKvKindOfKey(key)
  if (!kind) return false
  if (kind !== 'meta') return true
  return isContentMetaKey(key.slice('meta:'.length))
}

function contentKvKey(type: string, key: string): string {
  if (type === 'meta') return `meta:${key}`
  if (type === 'wordOverlay') return `word-overlay:${key}`
  if (type === 'packItems') return `pack-item:${key}`
  if (type === 'contentRejects') return `content-reject:${key}`
  if (type === 'decks') return `deck:${key}`
  if (type === 'words') return `word:${key}`
  if (type === 'packs') return `pack:${key}`
  return `${type}:${key}`
}

/** 内置词正文可再生（不进内容备份），清内容表后把残留 overlay 字段去掉，保证 IDB == 目标集合 */
async function clearStaleWordOverlays(db: ReturnType<typeof getDb>): Promise<void> {
  await db.words
    .filter((word) => WORD_OVERLAY_FIELDS.some((field) => (word as unknown as Record<string, unknown>)[field] !== undefined))
    .modify((word) => {
      const record = word as unknown as Record<string, unknown>
      for (const field of WORD_OVERLAY_FIELDS) delete record[field]
    })
}

async function clearContentTables(db: ReturnType<typeof getDb>): Promise<void> {
  const decks = await db.decks.toArray()
  const knownBuiltinIds = new Set(DECK_SOURCES.map((source) => source.deckId))
  const builtinDeckIds = new Set(decks.filter((deck) => Boolean(deck.builtinKey) || deck.source === 'builtin' || knownBuiltinIds.has(deck.id)).map((deck) => deck.id))
  for (const tableName of CONTENT_TABLES) {
    if (tableName === 'words') {
      const words = await db.words.toArray()
      const customIds = words.filter((word) => !builtinDeckIds.has(word.deckId) || word.custom === true).map((word) => word.id)
      if (customIds.length > 0) await db.words.bulkDelete(customIds)
      continue
    }
    const table = (db as unknown as Record<string, { clear: () => Promise<void> } | undefined>)[tableName]
    if (table) await table.clear()
  }
  const metaRows = (await db.meta.toArray()).filter((row) => CONTENT_META_PREFIXES.some((prefix) => row.key.startsWith(prefix)))
  for (const row of metaRows) await db.meta.delete(row.key)
  // 内置词正文保留，但其 overlay 属于内容，目标集合没有则必须清掉
  await clearStaleWordOverlays(db)
}

/** A6：优先沿用备份行原 updatedAt；没有有效原值时交给 native / IDB 补 now */
function resolveContentUpdatedAt(entity: ContentEntity): number | undefined {
  const value = Number(entity.updatedAt)
  if (Number.isFinite(value) && value > 0) return value
  const derived = updatedAtOf(entity.data)
  return derived > 0 ? derived : undefined
}

async function applyContentEntity(db: ReturnType<typeof getDb>, entity: ContentEntity): Promise<void> {
  // A6：导出时实体已消失（data=null）按 tombstone 跳过；A9：非内容实体不写
  if (!isContentEntity(entity) || entity.data === null || entity.data === undefined) return
  if (entity.type === 'meta') {
    const updatedAt = resolveContentUpdatedAt(entity) ?? Date.now()
    await db.meta.put({ key: entity.key, value: entity.data, updatedAt })
    return
  }
  if (entity.type === 'wordOverlay') {
    const word = await db.words.get(entity.key)
    if (word && typeof entity.data === 'object') await db.words.put({ ...word, ...(entity.data as Record<string, unknown>) } as typeof word)
    return
  }
  const table = tableOf(db, entity.type)
  if (table) await (table as unknown as { put: (value: unknown) => Promise<unknown> }).put(entity.data)
}

/** 清空内容表后从同一份最终集合重建 IDB（Dexie 事务原子：失败旧 IDB 不变） */
async function applyContentEntitiesReplacingIdb(db: ReturnType<typeof getDb>, entities: readonly ContentEntity[]): Promise<void> {
  await db.transaction('rw', [db.decks, db.words, db.packs, db.packItems, db.contentRejects, db.meta], async () => {
    await clearContentTables(db)
    for (const entity of entities) await applyContentEntity(db, entity)
  })
}

function countContentEntities(entities: readonly ContentEntity[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entity of entities) {
    if (!isContentEntity(entity) || entity.data === null || entity.data === undefined) continue
    counts[entity.type] = (counts[entity.type] ?? 0) + 1
  }
  return counts
}

/**
 * A1：全量分页读取 content_kv。
 * native `contentList` 的 fromRevision 是 `>=`，同一 revision 组可能跨页；本函数按
 * 「复用末 revision 组 + key 去重」推进，组内取尽后跳到下一页，避免只读第一页或死循环。
 */
async function listAllContentKvRows(pageSize = 500): Promise<ContentKvRow[]> {
  const { listContentByRevision } = await import('./content-store')
  const rows = new Map<string, ContentKvRow>()
  let since = 0
  for (let page = 0; page < 100_000; page += 1) {
    const result = await listContentByRevision(since, pageSize)
    if (!result.ok) throw new Error(result.error ?? '读取 content_kv 失败')
    let added = 0
    for (const row of result.rows) {
      if (rows.has(row.key)) continue
      rows.set(row.key, row)
      added += 1
    }
    if (!result.hasMore || result.rows.length === 0) return [...rows.values()]
    const pageMax = Math.max(since, ...result.rows.map((row) => row.revision))
    if (added === 0) {
      // 当前 revision 组已全部取到（单批 ≤500 = 页大小），跳到下一个 revision 继续
      since = pageMax + 1
      continue
    }
    // 复用末 revision 组，防止同组跨页被截断；重复行由 key 去重过滤
    since = pageMax
  }
  throw new Error('content_kv 全量分页超出上限')
}

interface ContentKvSyncPlan {
  upserts: ContentWriteInput[]
  deletes: ContentWriteInput[]
  before: Map<string, ContentKvRow>
}

/** 纯计算：最终实体集合 → content_kv upsert / delete 计划（含写前快照，供补偿） */
async function planContentKvSync(entities: readonly ContentEntity[]): Promise<ContentKvSyncPlan> {
  const upserts = new Map<string, ContentWriteInput>()
  for (const entity of entities) {
    if (!isContentEntity(entity) || entity.data === null || entity.data === undefined) continue
    const kind = contentKvKindOfType(entity.type)
    if (!kind) continue
    const key = contentKvKey(entity.type, entity.key)
    const updatedAt = resolveContentUpdatedAt(entity)
    upserts.set(key, { key, kind, json: JSON.stringify(entity.data), ...(updatedAt !== undefined ? { updatedAt } : {}) })
  }
  const existing = await listAllContentKvRows()
  const before = new Map<string, ContentKvRow>()
  const deletes: ContentWriteInput[] = []
  for (const row of existing) {
    // A9：content_kv 中非内容 key 不在恢复范围内
    if (!isContentKvKey(row.key)) continue
    before.set(row.key, row)
    if (upserts.has(row.key)) continue
    // A2：tombstone 行沿用原行 kind，保证 cache rebuild 能删对表
    deletes.push({ key: row.key, kind: row.kind, json: 'null', deleted: true })
  }
  return { upserts: [...upserts.values()], deletes, before }
}

async function writeContentRowsChunked(rows: readonly ContentWriteInput[]): Promise<void> {
  const { writeContentRows } = await import('./content-store')
  for (let i = 0; i < rows.length; i += 500) {
    const result = await writeContentRows(rows.slice(i, i + 500))
    if (!result.ok) throw new Error(result.error ?? 'content_kv 写入失败')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function composeFailure(prefix: string, error: unknown, undoError: string | null): string {
  const message = `${prefix}：${errorMessage(error)}`
  if (!undoError) return message
  // A5：undo 失败必须显式暴露（含错误码），不能吞掉半恢复状态
  return `${message}；content_kv 回滚失败（E_CONTENT_KV_ROLLBACK_FAILED）：${undoError}`
}

/** 恢复失败的诊断（`backup.*` 非 facts meta，与 backup.contentChain 同类；写失败不影响主流程） */
async function writeRestoreDiag(entry: Record<string, unknown>): Promise<void> {
  try {
    await getDb().meta.put({ key: 'backup.contentRestore.diag', value: { at: Date.now(), ...entry }, updatedAt: Date.now() })
  } catch {
    // 诊断写入失败不应掩盖原始恢复错误
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

/** A8：按写前快照补偿本次涉及的每个 key（已写则还原、已删则重建、原本已删则重新删除） */
function makeContentKvUndo(before: Map<string, ContentKvRow>, affected: Set<string>): () => Promise<void> {
  return async () => {
    const restore: ContentWriteInput[] = []
    const remove: ContentWriteInput[] = []
    for (const key of affected) {
      const row = before.get(key)
      if (row && row.deleted === 0) {
        restore.push({ key, kind: row.kind, json: row.json, updatedAt: row.updatedAt })
        continue
      }
      remove.push({ key, kind: row?.kind ?? contentKvKindOfKey(key) ?? 'meta', json: 'null', deleted: true })
    }
    await writeContentRowsChunked([...restore, ...remove])
  }
}

/** 0.14：sqlite 内容源时同步 content_kv；失败时补偿并抛错（由调用方保持 IDB 不变） */
async function syncContentKvFromEntities(entities: readonly ContentEntity[]): Promise<{ undo: () => Promise<void> } | null> {
  // 0.15：native 单一事实源（v15 done）时恢复必须写 content_kv；web 只写 IDB
  if (!(await isContentKvFactSource())) return null
  const plan = await planContentKvSync(entities)
  const affected = new Set<string>([
    ...plan.before.keys(),
    ...plan.upserts.map((row) => row.key),
    ...plan.deletes.map((row) => row.key),
  ])
  const undo = makeContentKvUndo(plan.before, affected)
  // A3：先一次性删除不在最终集合的 key，再 upsert 最终集合（两者 key 不相交）
  const changes: ContentWriteInput[] = [...plan.deletes, ...plan.upserts]
  if (changes.length === 0) return { undo }
  try {
    await writeContentRowsChunked(changes)
  } catch (error) {
    const undoError = await attemptContentKvUndo(undo)
    throw new Error(composeFailure('内容同步 content_kv 失败', error, undoError))
  }
  return { undo }
}

function validateContentManifest(manifest: ContentSnapshotManifest | undefined | null): string | null {
  if (!manifest || typeof manifest !== 'object') return '基线缺少 manifest'
  if (manifest.format !== CONTENT_SNAPSHOT_FORMAT) return '基线 manifest 格式不支持'
  if (manifest.formatVersion !== CONTENT_SNAPSHOT_VERSION) return '基线 manifest version 不支持'
  if (typeof manifest.snapshotId !== 'string' || manifest.snapshotId.length === 0) return '基线 manifest snapshotId 无效'
  if (!Number.isFinite(manifest.revision) || manifest.revision < 0) return '基线 manifest revision 无效'
  if (!Array.isArray(manifest.entries)) return '基线 manifest entries 无效'
  return null
}

/** A4：entities 必须与 manifest 索引逐条对齐，防止基线被截断 / 索引与正文被替换 */
function validateBaselineEntities(manifest: ContentSnapshotManifest, entities: readonly ContentEntity[] | undefined): string | null {
  if (!Array.isArray(entities)) return '基线实体缺失'
  if (manifest.entries.length !== entities.length) return `基线实体数与 manifest 不一致（${entities.length}/${manifest.entries.length}）`
  for (let index = 0; index < entities.length; index += 1) {
    const entry = manifest.entries[index]
    const entity = entities[index]
    if (!entry || !entity || entry.type !== entity.type || entry.key !== entity.key || entry.hash !== entity.hash) return `基线实体与 manifest 不一致（第 ${index} 条）`
  }
  return null
}

/**
 * A4：基线校验。checksum 覆盖 {snapshotId, revision, entities}；
 * 分块基线恢复链路（content-backup 由 index+parts 重组）checksum 为空，此时改由 part checksum 保证，
 * 这里仍强制校验 manifest 与 entities 的逐条一致性。
 */
function validateContentBaselineFile(file: ContentBaselineFile, opts: { allowEmptyChecksum?: boolean } = {}): string | null {
  if (!file || typeof file !== 'object') return '基线文件无效'
  if (file.format !== 'momo-content-baseline' || file.formatVersion !== 1) return '基线格式不支持'
  const manifestError = validateContentManifest(file.manifest)
  if (manifestError) return manifestError
  const entitiesError = validateBaselineEntities(file.manifest, file.entities)
  if (entitiesError) return entitiesError
  const checksum = typeof file.checksum === 'string' ? file.checksum : ''
  if (checksum.length === 0 && opts.allowEmptyChecksum === true) return null
  const payload = { snapshotId: file.manifest.snapshotId, revision: file.manifest.revision, entities: file.entities }
  if (checksum !== `fnv1a64:${hashOf(payload)}`) return '基线 checksum 不匹配'
  return null
}

/** A3：按增量链语义计算最终内容集合（每层先应用 tombstone 再应用 entity） */
function computeFinalContentEntities(base: readonly ContentEntity[], increments: readonly ContentIncrementPackage[]): ContentEntity[] {
  const final = new Map<string, ContentEntity>()
  for (const entity of base) final.set(contentEntityId(entity), entity)
  for (const pkg of increments) {
    for (const tombstone of pkg.tombstones) final.delete(contentEntityId(tombstone))
    for (const entity of pkg.entities) final.set(contentEntityId(entity), entity)
  }
  return [...final.values()]
}

interface CommitRestoreResult { ok: boolean; counts: Record<string, number>; error?: string }

/**
 * A7：先算好的最终集合 → content_kv（含写前快照）→ IDB 单事务；
 * 任一步失败补偿已写 content_kv / 已删 key（IDB 事务原子，失败旧 IDB 不变）。
 * A5：markContentChainSuccess 只在 kv + IDB 都成功后执行，它自身失败不回滚已提交内容。
 */
async function commitContentRestore(entities: readonly ContentEntity[], chain: { baseSnapshotId: string; revision: number; sequence: number }): Promise<CommitRestoreResult> {
  const db = getDb()
  const counts = countContentEntities(entities)
  let kvSync: { undo: () => Promise<void> } | null = null
  try {
    kvSync = await syncContentKvFromEntities(entities)
  } catch (error) {
    const message = errorMessage(error)
    // A5：content_kv 同步失败（若 undo 也失败，message 已含 E_CONTENT_KV_ROLLBACK_FAILED）
    await writeRestoreDiag({ stage: 'content_kv', error: message, rollbackFailed: message.includes('E_CONTENT_KV_ROLLBACK_FAILED') })
    return { ok: false, counts: {}, error: message }
  }
  try {
    await applyContentEntitiesReplacingIdb(db, entities)
  } catch (error) {
    const undoError = await attemptContentKvUndo(kvSync?.undo ?? null)
    const message = composeFailure('恢复内容到 IDB 失败', error, undoError)
    await writeRestoreDiag({ stage: 'idb', error: message, rollbackFailed: undoError !== null, undoError })
    return { ok: false, counts: {}, error: message }
  }
  try {
    await markContentChainSuccess(chain)
  } catch (error) {
    // A5：内容已提交，链状态失败不能回滚数据，但必须显式报错
    const message = `内容已恢复，但内容链状态更新失败：${errorMessage(error)}`
    await writeRestoreDiag({ stage: 'chain-meta', error: message })
    return { ok: false, counts, error: message }
  }
  if (kvSync) await clearContentKvStaleAfterRestore()
  return { ok: true, counts }
}

/** 完整基线恢复：按最终集合替换 content_kv + 非进度内容；失败旧库回滚；默认持全局写锁 */
export async function restoreContentBaseline(file: ContentBaselineFile, opts: ContentRestoreOptions = {}): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
  return opts.skipWriteLock === true ? restoreContentBaselineInner(file) : withDataWriteLock(() => restoreContentBaselineInner(file))
}

async function restoreContentBaselineInner(file: ContentBaselineFile): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
  const validation = validateContentBaselineFile(file)
  if (validation) return { ok: false, counts: {}, error: validation }
  return commitContentRestore(file.entities, {
    baseSnapshotId: file.manifest.snapshotId,
    revision: file.manifest.revision,
    sequence: 0,
  })
}

/** 恢复完整链：基线 + 依序增量，先算最终集合再同步 content_kv + IDB；逐层校验，失败整体回滚 */
export async function restoreContentIncrementChain(
  base: ContentBaselineFile,
  increments: readonly ContentIncrementPackage[],
  opts: ContentRestoreOptions = {},
): Promise<{ ok: boolean; revision: number; applied: number; error?: string }> {
  return opts.skipWriteLock === true
    ? restoreContentIncrementChainInner(base, increments)
    : withDataWriteLock(() => restoreContentIncrementChainInner(base, increments))
}

async function restoreContentIncrementChainInner(
  base: ContentBaselineFile,
  increments: readonly ContentIncrementPackage[],
): Promise<{ ok: boolean; revision: number; applied: number; error?: string }> {
  const baseRevision = Number((base as { manifest?: { revision?: unknown } } | undefined)?.manifest?.revision)
  const failed = (error: string): { ok: false; revision: number; applied: 0; error: string } => ({ ok: false, revision: Number.isFinite(baseRevision) && baseRevision >= 0 ? baseRevision : 0, applied: 0, error })
  // A4：base 与增量同等级校验（checksum/manifest/revision）
  const validation = validateContentBaselineFile(base, { allowEmptyChecksum: true })
  if (validation) return failed(validation)
  let revision = base.manifest.revision
  let parentSnapshotId = base.manifest.snapshotId
  for (const pkg of increments) {
    const chainValidation = validateContentIncrement(pkg, { ...base.manifest, snapshotId: parentSnapshotId, revision })
    if (!chainValidation.ok) return failed(chainValidation.reason)
    revision = pkg.newRevision
    parentSnapshotId = pkg.snapshotId
  }
  // A3：先完整计算目标集合，再一次性删除不在集合的 key、再 upsert（IDB 用同一份集合）
  const entities = computeFinalContentEntities(base.entities, increments)
  const result = await commitContentRestore(entities, {
    baseSnapshotId: base.manifest.snapshotId,
    revision,
    sequence: increments.length,
  })
  if (!result.ok) return { ok: false, revision: Number.isFinite(baseRevision) && baseRevision >= 0 ? baseRevision : 0, applied: 0, ...(result.error ? { error: result.error } : {}) }
  return { ok: true, revision, applied: increments.length }
}

export async function saveContentIncrementFile(storage: ContentBackupStorage, pkg: ContentIncrementPackage): Promise<{ ok: boolean; name: string; error?: string }> {
  const name = `content-increment-${pkg.newRevision}-${pkg.snapshotId}.json`
  const result = await storage.save(JSON.stringify(pkg), name)
  return { ok: result.ok, name: result.name ?? name, ...(result.error ? { error: result.error } : {}) }
}

export interface ContentBaselineChunkRef { name: string; count: number; checksum: string; bytes: number }
export interface ContentBaselineIndex {
  format: 'momo-content-baseline-index'
  formatVersion: 1
  manifest: ContentSnapshotManifest
  chunks: ContentBaselineChunkRef[]
  checksum: string
  createdAt: number
}

/** 分块创建基线：每个 part ≤ chunkSize 实体，避免单个 20MB 字符串常驻；返回 index 文件 */
export async function saveContentBaselineChunked(
  storage: ContentBackupStorage,
  manifest: ContentSnapshotManifest,
  opts: { chunkSize?: number; shouldAbort?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ ok: boolean; indexName?: string; chunks: number; bytes: number; error?: string }> {
  const chunkSize = Math.max(100, Math.min(500, Math.floor(opts.chunkSize ?? 300)))
  const prefix = `content-baseline-${manifest.revision}-${manifest.snapshotId}`
  const chunks: ContentBaselineChunkRef[] = []
  let bytes = 0
  try {
    for (let start = 0, part = 0; start < manifest.entries.length; start += chunkSize, part += 1) {
      if (opts.shouldAbort?.()) throw new Error('E_ABORTED: 基线创建已取消')
      const slice = manifest.entries.slice(start, start + chunkSize)
      const entities = await exportContentEntities(slice)
      const payload = { format: 'momo-content-baseline-chunk', formatVersion: 1, index: part, entities }
      const checksum = `fnv1a64:${hashOf(payload.entities.map(({ type, key, hash }) => ({ type, key, hash })))}`
      const name = `${prefix}-part-${String(part).padStart(3, '0')}.json`
      const text = JSON.stringify(payload)
      const saved = await storage.save(text, name)
      if (!saved.ok) throw new Error(saved.error ?? `part ${part} 保存失败`)
      chunks.push({ name: saved.name ?? name, count: entities.length, checksum, bytes: text.length })
      bytes += text.length
      opts.onProgress?.(Math.min(start + chunkSize, manifest.entries.length), manifest.entries.length)
    }
    const index: ContentBaselineIndex = {
      format: 'momo-content-baseline-index',
      formatVersion: 1,
      manifest,
      chunks,
      checksum: `fnv1a64:${hashOf({ snapshotId: manifest.snapshotId, revision: manifest.revision, chunks: chunks.map((chunk) => chunk.checksum) })}`,
      createdAt: Date.now(),
    }
    const text = JSON.stringify(index)
    const name = `${prefix}-index.json`
    const saved = await storage.save(text, name)
    if (!saved.ok) throw new Error(saved.error ?? '基线 index 保存失败')
    return { ok: true, indexName: saved.name ?? name, chunks: chunks.length, bytes: bytes + text.length }
  } catch (error) {
    return { ok: false, chunks: chunks.length, bytes, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 分块基线恢复：读 index + 各 part，校验后按最终集合替换 content_kv + IDB；失败旧库不变 */
export async function restoreContentBaselineIndexed(
  storage: ContentBackupStorage,
  indexName: string,
  opts: ContentRestoreOptions = {},
): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
  return opts.skipWriteLock === true ? restoreContentBaselineIndexedInner(storage, indexName) : withDataWriteLock(() => restoreContentBaselineIndexedInner(storage, indexName))
}

async function restoreContentBaselineIndexedInner(
  storage: ContentBackupStorage,
  indexName: string,
): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
  try {
    const indexText = storage.read(indexName)
    if (!indexText) return { ok: false, counts: {}, error: '基线 index 不存在' }
    const index = JSON.parse(indexText) as ContentBaselineIndex
    if (!index || index.format !== 'momo-content-baseline-index' || index.formatVersion !== 1) return { ok: false, counts: {}, error: '基线 index 格式不支持' }
    const manifestError = validateContentManifest(index.manifest)
    if (manifestError) return { ok: false, counts: {}, error: manifestError }
    if (!Array.isArray(index.chunks)) return { ok: false, counts: {}, error: '基线 index chunks 无效' }
    // A9：index checksum 覆盖 manifest revision/snapshotId + 每个 part 的 checksum，防止 manifest 被伪造
    const expectedIndexChecksum = `fnv1a64:${hashOf({ snapshotId: index.manifest.snapshotId, revision: index.manifest.revision, chunks: index.chunks.map((chunk) => chunk.checksum) })}`
    if (index.checksum !== expectedIndexChecksum) return { ok: false, counts: {}, error: '基线 index checksum 不匹配' }
    const entities: ContentEntity[] = []
    for (const ref of index.chunks) {
      const text = storage.read(ref.name)
      if (!text) return { ok: false, counts: {}, error: `缺少 part：${ref.name}` }
      const payload = JSON.parse(text) as { entities?: ContentEntity[] }
      if (!payload || !Array.isArray(payload.entities)) return { ok: false, counts: {}, error: `part 内容无效：${ref.name}` }
      const checksum = `fnv1a64:${hashOf(payload.entities.map(({ type, key, hash }) => ({ type, key, hash })))}`
      if (checksum !== ref.checksum) return { ok: false, counts: {}, error: `part 校验失败：${ref.name}` }
      // A9：part checksum 只覆盖 {type,key,hash}，需再核对正文 data 与 hash（防只改正文、保留 hash）
      for (const entity of payload.entities) {
        if (entity.data === null || entity.data === undefined) continue
        if (hashContentValue(entity.data) !== entity.hash) return { ok: false, counts: {}, error: `part 实体 hash 校验失败：${ref.name}（${entity.type}:${entity.key}）` }
      }
      entities.push(...payload.entities)
    }
    if (entities.length !== index.chunks.reduce((sum, chunk) => sum + chunk.count, 0)) return { ok: false, counts: {}, error: '基线实体数不一致' }
    const entitiesError = validateBaselineEntities(index.manifest, entities)
    if (entitiesError) return { ok: false, counts: {}, error: entitiesError }
    return await commitContentRestore(entities, {
      baseSnapshotId: index.manifest.snapshotId,
      revision: index.manifest.revision,
      sequence: 0,
    })
  } catch (error) {
    return { ok: false, counts: {}, error: error instanceof Error ? error.message : String(error) }
  }
}
