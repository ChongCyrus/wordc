/**
 * 0.14/0.15：内容写源 + 内置词 overlay 统一写入口（root/notes 样板）。
 *
 * 0.15 single-source：
 * - 原生 APK（MomoBridge momo-apk + 原生 SQLite 可用）= SQLite 唯一事实源；v15 一次性迁移完成后
 *   getContentWriteSource() 恒为 sqlite，旧 settings `data.contentWriteSource` 只作 0.14 迁移输入；
 * - Web/PWA = IDB 唯一事实源，永远不出现 sqlite 写源；
 * - emergency rollback 仅内部/调试：meta `contentWriteSourceEmergency` 覆盖为 idb。
 */
import { isSqliteAvailable, sqliteQuery, sqliteTx } from './native-sqlite'
import { getDb } from './db'
import { getSettings, updateSettings } from './settings.repo'
import { wordOverlayOf } from './content-snapshot'
import { writeContentRows } from './content-store'
import type { Word } from '../core'

export type ContentWriteSource = 'idb' | 'sqlite'
/** 0.14 遗留 settings（0.15 只作迁移输入/兼容镜像，不再由用户切换） */
export const CONTENT_WRITE_SOURCE_KEY = 'data.contentWriteSource'
/** 0.15 emergency rollback（仅内部/调试）：{ source:'idb', at, reason } 时 getContentWriteSource 返回 idb */
export const CONTENT_WRITE_SOURCE_EMERGENCY_KEY = 'contentWriteSourceEmergency'
/** 0.15 v15 一次性内容迁移标记：durable truth 在 SQLite migration_state（step=CONTENT_V15_MIGRATION_STEP），这里是 IDB meta mirror */
export const CONTENT_MIGRATION_V15_KEY = 'contentMigrationV15'
export const CONTENT_V15_MIGRATION_STEP = 'content-v15'

export type ContentMigrationV15Status = 'running' | 'done' | 'failed'
export type ContentMigrationV15From = 'legacy-sqlite-ready' | 'legacy-idb' | 'fresh'
export interface ContentMigrationV15State {
  status: ContentMigrationV15Status
  at: number
  from?: ContentMigrationV15From
  attempt?: number
  finishedAt?: number
  error?: string
  code?: string
  needsRerun?: boolean
  counts?: { total?: number; revision?: number; idbContent?: number }
}

export class ContentWriteError extends Error {
  code: string
  constructor(message: string, code = 'CONTENT_WRITE_FAILED') { super(message); this.code = code; this.name = 'ContentWriteError' }
}

/** 原生 APK WebView（MomoBridge.isNativeApp()==='momo-apk'） */
function isNativeApkRuntime(): boolean {
  try {
    const w = globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }
    return w.MomoBridge?.isNativeApp?.() === 'momo-apk'
  } catch {
    return false
  }
}

/** 0.15：原生 APK 且原生 SQLite 可用 → 内容事实源必须是 SQLite */
export function isNativeContentSqliteRuntime(): boolean {
  return isNativeApkRuntime() && isSqliteAvailable()
}

let contentMigrationV15DoneCache: boolean | null = null

/** 迁移状态变化/测试隔离后失效缓存 */
export function invalidateContentMigrationV15Cache(): void {
  contentMigrationV15DoneCache = null
}

function v15StateOf(value: unknown): ContentMigrationV15State | null {
  // 兼容早期契约的裸 'done' / true
  if (value === 'done' || value === true) return { status: 'done', at: 0 }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<ContentMigrationV15State> & { state?: unknown; done?: unknown }
  const status = record.status ?? (record.state === 'done' || record.done === true ? 'done' : undefined)
  if (status !== 'running' && status !== 'done' && status !== 'failed') return null
  return { ...(record as ContentMigrationV15State), status, at: Number(record.at ?? 0) || 0 }
}

/** 0.15：v15 迁移状态（IDB mirror 对象；读取兼容裸 'done'） */
export async function getContentMigrationV15State(): Promise<ContentMigrationV15State | null> {
  try {
    return v15StateOf((await getDb().meta.get(CONTENT_MIGRATION_V15_KEY))?.value)
  } catch {
    return null
  }
}

interface V15SqliteMarker { found: boolean; done: boolean }
async function readContentMigrationV15MarkerFromSqlite(): Promise<V15SqliteMarker | null> {
  if (!isSqliteAvailable()) return null
  try {
    const response = await sqliteQuery({ table: 'migration_state', where: { step: CONTENT_V15_MIGRATION_STEP }, limit: 1 }, 5_000)
    if (response.ok === false) return null
    const rows = (response.rows as Array<Record<string, unknown>> | undefined) ?? []
    if (rows.length === 0) return { found: false, done: false }
    return { found: true, done: rows[0]?.status === 'done' }
  } catch {
    return null
  }
}

/**
 * 0.15：v15 一次性迁移是否完成。durable SQLite migration_state 优先（WebView 数据被清也能兜底），
 * 再回退 IDB mirror；带会话缓存（invalidateContentMigrationV15Cache 失效）。
 */
/** 0.15：SQLite durable marker 是否存在且 done（不回落 IDB mirror） */
export async function hasDurableContentMigrationV15Marker(): Promise<boolean> {
  const durable = await readContentMigrationV15MarkerFromSqlite()
  return durable?.found === true && durable.done === true
}

export async function isContentMigrationV15Done(): Promise<boolean> {
  if (contentMigrationV15DoneCache !== null) return contentMigrationV15DoneCache
  const durable = await readContentMigrationV15MarkerFromSqlite()
  // 读以 SQLite 为准：SQLite 有 marker（任何状态）就以它为准；无 marker/不可读才回退 IDB mirror
  if (durable?.found) {
    contentMigrationV15DoneCache = durable.done
    return contentMigrationV15DoneCache
  }
  const mirror = await getContentMigrationV15State()
  contentMigrationV15DoneCache = mirror?.status === 'done'
  return contentMigrationV15DoneCache
}

/**
 * 0.15：写 v15 迁移状态。durable SQLite 先写（status=done 必须成功，否则抛错=迁移失败），
 * 再写 IDB mirror，最后维护缓存。
 */
export async function writeContentMigrationV15State(state: ContentMigrationV15State): Promise<void> {
  const previous = await getContentMigrationV15State().catch(() => null)
  if (isSqliteAvailable()) {
    try {
      const tx = await sqliteTx(
        [{
          op: 'upsert',
          table: 'migration_state',
          row: {
            step: CONTENT_V15_MIGRATION_STEP,
            status: state.status,
            started_at: previous?.status === 'running' ? previous.at : state.at,
            finished_at: state.status === 'running' ? null : state.finishedAt ?? state.at,
            error: state.error ?? null,
          },
        }],
        { timeoutMs: 10_000 },
      )
      if (tx.ok === false) throw new Error(tx.message ?? 'SQLite migration_state 写入失败')
      // done 的 durable 写成功即生效（SQLite 是权威读）
      if (state.status === 'done') contentMigrationV15DoneCache = true
    } catch (error) {
      if (state.status === 'done') throw error
    }
  }
  const next: ContentMigrationV15State = { ...(previous ?? {}), ...state }
  try {
    await getDb().meta.put({ key: CONTENT_MIGRATION_V15_KEY, value: next, updatedAt: Date.now() })
  } catch (error) {
    // durable done 已生效时，IDB mirror 失败不降级为失败（mirror 仅供 UI/旧读取方）
    if (state.status !== 'done') throw error
  }
  if (state.status !== 'done') contentMigrationV15DoneCache = null
}

/** 0.15：emergency override 是否把写源强制为 idb（仅内部/调试） */
export async function isContentSourceEmergencyIdb(): Promise<boolean> {
  try {
    const value = (await getDb().meta.get(CONTENT_WRITE_SOURCE_EMERGENCY_KEY))?.value as { source?: string } | undefined
    return value?.source === 'idb'
  } catch {
    return false
  }
}

export async function setContentSourceEmergencyIdb(reason = 'emergency-rollback'): Promise<void> {
  await getDb().meta.put({ key: CONTENT_WRITE_SOURCE_EMERGENCY_KEY, value: { source: 'idb', at: Date.now(), reason }, updatedAt: Date.now() })
}

export async function clearContentSourceEmergency(): Promise<void> {
  await getDb().meta.delete(CONTENT_WRITE_SOURCE_EMERGENCY_KEY)
}

/** 0.14 旧迁移状态（只读；contentMigrationState meta，与 content-migration-plan 同 key） */
async function readLegacyMigrationStateStatus(): Promise<string | null> {
  try {
    const value = (await getDb().meta.get('contentMigrationState'))?.value as { status?: unknown } | undefined
    return typeof value?.status === 'string' ? value.status : null
  } catch {
    return null
  }
}

/** 0.14 迁移输入：只读旧 settings 写源（v15 done 后不再作为运行时依据） */
export async function getLegacyContentWriteSource(): Promise<ContentWriteSource> {
  const settings = await getSettings().catch(() => ({} as Record<string, unknown>))
  return settings[CONTENT_WRITE_SOURCE_KEY] === 'sqlite' ? 'sqlite' : 'idb'
}

/**
 * 0.15：运行时内容写源（唯一判定入口）。
 * - 非原生 content runtime（Web/PWA/无原生 SQLite）→ idb（settings 残留 sqlite 也不认）
 * - native：emergency idb override > v15 done → sqlite > 旧 settings（0.14 迁移输入）
 */
export async function getContentWriteSource(): Promise<ContentWriteSource> {
  if (!isNativeContentSqliteRuntime()) {
    // 真实 Web/PWA（有 window）：IDB 唯一事实源，settings 残留 sqlite 也不认。
    // Node 测试环境（vitest env=node，无 window）沿用 0.14 settings 语义，
    // 供既有数据层测试用 settings+sqlite mock 模拟原生；生产 Web 不会走这条分支。
    if (typeof window === 'undefined') return getLegacyContentWriteSource()
    return 'idb'
  }
  if (await isContentSourceEmergencyIdb()) return 'idb'
  // C2：durable marker=done 优先于 IDB mirror 的 running；避免恢复旧 mirror 把写源降回 idb
  if (await isContentMigrationV15Done()) return 'sqlite'
  // 0.15 规则：v15 迁移进行中一律仍 idb，只有旧 0.14 已是 sqlite+ready 的基线保持 sqlite
  const v15 = await getContentMigrationV15State()
  if (v15?.status === 'running') {
    const legacy = await getLegacyContentWriteSource()
    if (legacy !== 'sqlite') return 'idb'
    return (await readLegacyMigrationStateStatus()) === 'ready' ? 'sqlite' : 'idb'
  }
  return getLegacyContentWriteSource()
}

export async function persistContentWriteSource(source: ContentWriteSource): Promise<void> {
  // 0.14 兼容镜像（0.15 不再作为 native 运行时依据）；写后失效 v15 缓存，避免测试/回退场景读到旧判定
  invalidateContentMigrationV15Cache()
  await updateSettings({ [CONTENT_WRITE_SOURCE_KEY]: source }, { allowContentWriteSource: true })
}

export interface SaveWordContentResult { source: ContentWriteSource; revision: number }

/** 写内置词 overlay：sqlite 模式先写 content_kv（失败 fail-closed，不写 IDB），成功后写 IDB cache + 事件 */
export async function saveWordOverlay(word: Word, opts: { skipSqlite?: boolean } = {}): Promise<SaveWordContentResult> {
  const source = await getContentWriteSource()
  if (source === 'sqlite' && opts.skipSqlite !== true) {
    const overlay = wordOverlayOf(word as unknown as Record<string, unknown>)
    const result = await writeContentRows([{ key: `word-overlay:${word.id}`, kind: 'word-overlay', json: JSON.stringify(overlay), updatedAt: Date.now() }])
    if (!result.ok) throw new ContentWriteError(result.error ?? 'SQLite 内容写入失败', 'CONTENT_SQLITE_WRITE_FAILED')
    try { await getDb().words.put(word) } catch {
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('word-overlay-cache-write-failed').catch(() => undefined)
    }
    try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('momo:content-changed', { detail: { type: 'word-overlay', key: word.id } })) } catch { /* ignore */ }
    return { source, revision: result.revision }
  }
  await getDb().words.put(word)
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('momo:content-changed', { detail: { type: 'word-overlay', key: word.id } })) } catch { /* ignore */ }
  return { source, revision: 0 }
}

export interface ContentEntityRow { key: string; kind: 'deck' | 'word' | 'word-overlay' | 'pack' | 'pack-item' | 'content-reject' | 'meta'; json: string; updatedAt?: number; deleted?: boolean }
export interface SaveContentEntitiesResult { ok: boolean; written: number; revision: number; error?: string }

export async function applyContentCache(rows: ContentEntityRow[]): Promise<void> {
  const db = getDb()
  // 先写非 overlay 内容（deck/word/pack/...），最后应用 overlay，避免被 word 正文覆盖
  for (const row of rows.filter((item) => item.kind !== 'word-overlay')) {
    const id = row.key.replace(/^(deck|word|pack|pack-item|content-reject|meta):/, '')
    if (row.kind === 'meta') { if (row.deleted) await db.meta.delete(id); else await db.meta.put({ key: id, value: JSON.parse(row.json), updatedAt: Date.now() }); continue }
    const table = row.kind === 'deck' ? db.decks : row.kind === 'word' ? db.words : row.kind === 'pack' ? db.packs : row.kind === 'pack-item' ? db.packItems : db.contentRejects
    if (row.deleted) await table.delete(id)
    else await table.put(JSON.parse(row.json) as never)
  }
  const overlays = rows.filter((row) => row.kind === 'word-overlay' && !row.deleted)
  if (overlays.length > 0) {
    const ids = overlays.map((row) => row.key.replace(/^word-overlay:/, ''))
    const words = await db.words.bulkGet(ids)
    const next = words.map((word, index) => word ? { ...word, ...(JSON.parse(overlays[index]!.json) as Record<string, unknown>) } : null).filter((word): word is NonNullable<typeof word> => Boolean(word))
    if (next.length > 0) await db.words.bulkPut(next as never)
  }
  for (const row of rows.filter((item) => item.kind === 'word-overlay' && item.deleted)) {
    const id = row.key.replace(/^word-overlay:/, '')
    await db.words.update(id, { rootEtymology: undefined } as never).catch(() => undefined)
  }
}

/** B1/B2 统一批量：≤500/批；SQLite 成功后才写 IDB cache；失败不回写 */
export async function saveContentEntitiesBatch(rows: readonly ContentEntityRow[]): Promise<SaveContentEntitiesResult> {
  if (rows.length === 0) return { ok: true, written: 0, revision: 0 }
  if (rows.length > 500) return { ok: false, written: 0, revision: 0, error: '单批超过 500 条' }
  const source = await getContentWriteSource()
  if (source === 'idb') {
    await applyContentCache([...rows])
    return { ok: true, written: rows.length, revision: 0 }
  }
  const result = await writeContentRows(rows.map((row) => ({ key: row.key, kind: row.kind, json: row.json, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}), ...(row.deleted ? { deleted: true } : {}) })))
  if (!result.ok) return { ok: false, written: 0, revision: result.revision, error: result.error ?? '内容批量写入失败' }
  try { await applyContentCache([...rows]) } catch {
    const { markIdbCacheDirty } = await import('./idb-cache')
    await markIdbCacheDirty('content-entities-cache-write-failed').catch(() => undefined)
  }
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('momo:content-changed', { detail: { type: 'batch', count: rows.length } })) } catch { /* ignore */ }
  return { ok: true, written: rows.length, revision: result.revision }
}

/** 按 500 自动切批；部分失败停止并返回已写 */
export async function saveContentEntitiesChunked(rows: readonly ContentEntityRow[]): Promise<SaveContentEntitiesResult> {
  let written = 0; let revision = 0
  for (let i = 0; i < rows.length; i += 500) {
    const result = await saveContentEntitiesBatch(rows.slice(i, i + 500))
    revision = result.revision || revision
    if (!result.ok) return { ok: false, written, revision, error: result.error }
    written += result.written
  }
  return { ok: true, written, revision }
}
