/**
 * 0.14/0.15：内容写源相关内部动作。
 *
 * 0.15 single-source：
 * - 用户不再有「切换内容写源」入口；native 由 `ensureContentSourceV15` 一次性收敛到 SQLite，
 *   Web 恒为 IDB。
 * - 保留 emergency rollback（仅内部/调试）：native v15 done 后写 meta override 仍可强制 idb。
 * - 导入/恢复后统一调 `ensureContentSourceAfterImport()`（替代 0.14 的 reset 语义）。
 */
import { canSwitchContentWriteSource, getContentMigrationState, CONTENT_MIGRATION_STATE_KEY } from './content-migration-plan'
import {
  clearContentSourceEmergency,
  getContentWriteSource,
  isContentMigrationV15Done,
  isNativeContentSqliteRuntime,
  persistContentWriteSource,
  setContentSourceEmergencyIdb,
} from './content-write-source'
import type { ContentEntityRow } from './content-write-source'
import type { ContentWriteSource } from './content-write-source'
import { CONTENT_KV_STALE_KEY, listContentRowsPage, readContentCounts, writeContentRows } from './content-store'
import { getDb } from './db'
import { withDataWriteLock } from './write-lock'

export async function switchContentWriteSource(opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }> } = {}): Promise<{ ok: boolean; error?: string }> {
  return withDataWriteLock(async () => {
    try {
      // 0.15：native v15 done 后内容写源固定 SQLite，不再支持手动切换（emergency 用 rollbackContentWriteSource）
      if (isNativeContentSqliteRuntime() && (await isContentMigrationV15Done().catch(() => false))) {
        return { ok: false, error: '0.15 原生内容写源已固定为 SQLite，不再支持手动切换（emergency 请用 rollbackContentWriteSource）' }
      }
      const allowed = await canSwitchContentWriteSource()
      if (!allowed.ok) return { ok: false, error: allowed.reason ?? '当前不允许切换内容写源' }
      if (opts.preBackup) {
        const backup = await opts.preBackup()
        if (backup && backup.ok === false) return { ok: false, error: `切换前备份失败：${backup.error ?? '未知错误'}` }
      }
      const counts = await readContentCounts()
      if (counts.total <= 0) return { ok: false, error: 'content_kv 为空，拒绝切换' }
      await persistContentWriteSource('sqlite')
      await getDb().meta.put({ key: 'contentWriteSourceSwitchedAt', value: { at: Date.now(), revision: counts.revision, rows: counts.total }, updatedAt: Date.now() })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/**
 * 从恢复包导入时必须调用：强制 idb，清迁移状态，不信任跨设备 sqlite 源。
 * content_kv 若还有 live 行，标记 stale；未清理前禁止切源/按 kv 备份，避免旧内容复活。
 */
export async function resetContentWriteSourceForImport(): Promise<void> {
  // 0.15：native v15 done 后写源固定 sqlite；旧 reset 语义不得生效（仅留 diag，供旧调用方兼容）
  if (isNativeContentSqliteRuntime() && (await isContentMigrationV15Done().catch(() => false))) {
    await getDb().meta.put({ key: 'contentWriteSourceResetForImport.skipped', value: { at: Date.now(), reason: 'v15 done: source stays sqlite' }, updatedAt: Date.now() }).catch(() => undefined)
    return
  }
  const counts = await readContentCounts().catch(() => null)
  await persistContentWriteSource('idb')
  await getDb().meta.delete(CONTENT_MIGRATION_STATE_KEY)
  const meta = getDb().meta
  if (counts && counts.total > 0 && counts.deleted < counts.total) {
    await meta.put({ key: CONTENT_KV_STALE_KEY, value: { at: Date.now(), total: counts.total, deleted: counts.deleted }, updatedAt: Date.now() })
  } else {
    await meta.delete(CONTENT_KV_STALE_KEY)
  }
  await meta.put({ key: 'contentWriteSourceResetForImport', value: { at: Date.now(), stale: Boolean(counts && counts.total > 0 && counts.deleted < counts.total) }, updatedAt: Date.now() })
}

/**
 * 清理导入后遗留的过期 content_kv：把所有 live 行 tombstone，再清 stale/迁移状态。
 * 仅 IDB 是事实源时使用；用于之后重新全量迁移。
 */
export async function discardStaleContentKv(): Promise<{ ok: boolean; cleared: number; error?: string }> {
  try {
    if ((await getContentWriteSource()) === 'sqlite') {
      return { ok: false, cleared: 0, error: '当前 content_kv 仍是写源，拒绝清理' }
    }
    const live: Array<{ key: string; kind: string; json: string; updatedAt: number }> = []
    // 按 key + offset 分页（contentList fromRevision 的 >= 语义会重复末行，不能用于全量遍历）
    for (let offset = 0; offset < 100_000; offset += 500) {
      const result = await listContentRowsPage({ offset, limit: 500, includeDeleted: false, orderBy: 'key' })
      if (!result.ok) throw new Error(result.error ?? '读取 content_kv 失败')
      for (const row of result.rows) {
        if (row.deleted === 0) live.push({ key: row.key, kind: row.kind, json: 'null', updatedAt: Date.now() })
      }
      if (!result.hasMore || result.rows.length === 0) break
    }
    for (let i = 0; i < live.length; i += 500) {
      const chunk = live.slice(i, i + 500)
      const written = await writeContentRows(chunk.map((row) => ({ ...row, deleted: true })) as never)
      if (!written.ok) throw new Error(written.error ?? '清理 content_kv 失败')
    }
    await getDb().meta.delete(CONTENT_KV_STALE_KEY)
    await getDb().meta.delete(CONTENT_MIGRATION_STATE_KEY)
    return { ok: true, cleared: live.length }
  } catch (error) {
    return { ok: false, cleared: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function reconcileInterruptedContentMigration(): Promise<{ ok: boolean; rescued: boolean }> {
  const state = await getContentMigrationState() as (Record<string, unknown> | null)
  if (!state || state.status !== 'running') return { ok: true, rescued: false }
  await getDb().meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { ...state, status: 'failed', error: '迁移中断（running 未完成），需要重跑', at: Date.now() }, updatedAt: Date.now() })
  if ((await getContentWriteSource()) === 'sqlite') await persistContentWriteSource('idb')
  return { ok: true, rescued: true }
}

/**
 * Emergency rollback（仅内部/调试，UI 不再暴露）：把内容写源强制回 IDB。
 * 0.15：native v15 done 后旧 settings 已不生效，必须写 meta override 才会真正回 idb。
 * 调用方需自行确保 IDB cache 与 content_kv 一致（如先 rebuildContentCacheFromSqlite）。
 */
export async function rollbackContentWriteSource(opts: { reason?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    if (isNativeContentSqliteRuntime()) await setContentSourceEmergencyIdb(opts.reason ?? 'emergency-rollback')
    await persistContentWriteSource('idb')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 清除 emergency override（内部/调试）；v15 done 后恢复 sqlite，否则回旧 settings 语义。 */
export async function clearContentWriteSourceEmergency(): Promise<{ ok: boolean; error?: string }> {
  try {
    await clearContentSourceEmergency()
    const target: ContentWriteSource = (await isContentMigrationV15Done().catch(() => false)) ? 'sqlite' : 'idb'
    await persistContentWriteSource(target)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ========================================================================== *
 * 0.15 B：导入/恢复后的内容写源（task-294 契约）
 * ========================================================================== */

export interface ContentSourceAfterImportResult {
  ok: boolean
  source: ContentWriteSource
  /** native sqlite 下按差集补 tombstone 的 content_kv live 实体行数 */
  tombstoned: number
  error?: string
  code?: string
}

const IMPORT_ENTITY_KINDS = new Set(['deck', 'word', 'word-overlay', 'pack', 'pack-item', 'content-reject', 'meta'])

/**
 * 0.15：导入成功后调用（替代 0.14 的 resetContentWriteSourceForImport；不要在外层锁内再套锁）。
 * - native 且导入前写源已是 sqlite（含 0.14 已切 + v15 尚未 done 的过渡设备）：保持 sqlite，
 *   不清迁移状态；按差集 tombstone content_kv 中 live 但不在 IDB 内容事实源的实体行
 *   （deck/word/pack/pack-item/content-reject；word-overlay/meta 由各自写入口管理，不动）。
 * - web / 导入前写源为 idb：保持 0.14 语义（persist idb + 清 0.14 contentMigrationState + 若 kv 有
 *   live 行标 stale）；**不动 v15 marker**，下次 ensureContentSourceV15 会先处理 stale 再迁移。
 * - 失败返回 ok:false 且不改变调用前写源（fail-closed，调用方按导入告警处理）。
 */
export async function ensureContentSourceAfterImport(opts: { idbContentKeys?: readonly string[] } = {}): Promise<ContentSourceAfterImportResult> {
  const sourceBefore = await getContentWriteSource().catch(() => (opts.idbContentKeys ? 'sqlite' : 'idb') as ContentWriteSource)
  try {
    if (sourceBefore === 'sqlite' && isNativeContentSqliteRuntime()) {
      // A-P1-4：IDB cache 不可信/落后时，不能以 cache 为基准 tombstone 合法 kv 内容
      const { getIdbCacheMeta } = await import('./idb-cache')
      const cache = await getIdbCacheMeta().catch(() => null)
      if (cache?.dirty) {
        return { ok: false, source: 'sqlite', tombstoned: 0, error: 'IDB 内容 cache dirty，跳过导入差集以免误删 content_kv；请重建 cache 后重试', code: 'E_IDB_CACHE_DIRTY_AFTER_IMPORT' }
      }
      const tombstoned = await tombstoneStaleContentKvEntities(opts.idbContentKeys)
      await persistContentWriteSource('sqlite').catch(() => undefined)
      await getDb().meta.delete(CONTENT_KV_STALE_KEY).catch(() => undefined)
      return { ok: true, source: 'sqlite', tombstoned }
    }
    // 0.14 语义（web / 迁移未完成）：强制 idb，清旧迁移状态；kv 有 live 行则标 stale（不删数据）
    await persistContentWriteSource('idb')
    const counts = await readContentCounts().catch(() => null)
    await getDb().meta.delete(CONTENT_MIGRATION_STATE_KEY).catch(() => undefined)
    if (counts && counts.total > counts.deleted) {
      await getDb().meta.put({ key: CONTENT_KV_STALE_KEY, value: { at: Date.now(), total: counts.total, deleted: counts.deleted, reason: 'ensureContentSourceAfterImport' }, updatedAt: Date.now() })
    } else {
      await getDb().meta.delete(CONTENT_KV_STALE_KEY).catch(() => undefined)
    }
    return { ok: true, source: 'idb', tombstoned: 0 }
  } catch (error) {
    return { ok: false, source: sourceBefore, tombstoned: 0, error: error instanceof Error ? error.message : String(error), code: 'E_CONTENT_SOURCE_AFTER_IMPORT' }
  }
}

/** content_kv live 但不在 IDB 内容事实源（实体类 kind）的旧行 → tombstone；防止 cache 重建复活旧内容 */
async function tombstoneStaleContentKvEntities(idbContentKeys?: readonly string[]): Promise<number> {
  const db = getDb()
  const live: Array<{ key: string; kind: string }> = []
  for (let offset = 0; offset < 1_000_000; offset += 500) {
    const page = await listContentRowsPage({ offset, limit: 500, includeDeleted: false, orderBy: 'key' })
    if (!page.ok) throw new Error(page.error ?? '读取 content_kv 失败')
    for (const row of page.rows) if (row.deleted === 0 && IMPORT_ENTITY_KINDS.has(row.kind)) live.push({ key: row.key, kind: row.kind })
    if (!page.hasMore || page.rows.length === 0) break
  }
  if (live.length === 0) return 0
  const current = new Set<string>(idbContentKeys ?? [])
  if (!idbContentKeys) {
    const kinds = new Set(live.map((row) => row.kind))
    if (kinds.has('deck')) for (const deck of await db.decks.toArray()) current.add(`deck:${deck.id}`)
    if (kinds.has('word')) for (const word of await db.words.toArray()) current.add(`word:${word.id}`)
    if (kinds.has('pack')) for (const pack of await db.packs.toArray()) current.add(`pack:${pack.id}`)
    if (kinds.has('pack-item')) for (const item of await db.packItems.toArray()) current.add(`pack-item:${item.id}`)
    if (kinds.has('content-reject')) for (const reject of await db.contentRejects.toArray()) current.add(`content-reject:${reject.id}`)
    if (kinds.has('word-overlay')) {
      for (const word of await db.words.toArray()) {
        { const { WORD_OVERLAY_FIELDS } = await import('./content-snapshot'); if (WORD_OVERLAY_FIELDS.some((field) => (word as unknown as Record<string, unknown>)[field] !== undefined)) current.add(`word-overlay:${word.id}`) }
      }
    }
    if (kinds.has('meta')) {
      const { CONTENT_META_PREFIXES } = await import('./content-snapshot')
      for (const row of await db.meta.toArray()) if (CONTENT_META_PREFIXES.some((prefix) => row.key.startsWith(prefix))) current.add(`meta:${row.key}`)
    }
  }
  const stale = live.filter((row) => !current.has(row.key))
  let tombstoned = 0
  for (let i = 0; i < stale.length; i += 500) {
    const chunk = stale.slice(i, i + 500)
    const saved = await writeContentRows(chunk.map((row) => ({ key: row.key, kind: row.kind as ContentEntityRow['kind'], json: 'null', deleted: true })))
    if (!saved.ok) throw new Error(saved.error ?? '清理 content_kv 差集失败')
    tombstoned += chunk.length
  }
  return tombstoned
}
