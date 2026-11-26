/** 导入/恢复把内容写源重置回 IDB 后，content_kv 视为过期；未清理前禁止切源/读内容库。 */
export const CONTENT_KV_STALE_KEY = 'contentKvStale'

/** 0.14：content_kv JS 适配（native contentList/contentGet/contentWrite/contentCounts 精确协议） */
import { sqliteCall, sqliteHealth } from './native-sqlite'

export const CONTENT_SCHEMA_VERSION = 3
export const CONTENT_REVISION_KEY = 'content_revision'
export const CONTENT_PAGE_SIZE = 200
// 0.16.10：原生 SQLite 单线程串行，首启 seeding/导入期间查询会排队；读类调用放宽到 60s 避免假超时
const TIMEOUT = 60_000

export type ContentKind = 'deck' | 'word' | 'word-overlay' | 'pack' | 'pack-item' | 'content-reject' | 'meta'

export interface ContentKvRow { key: string; kind: ContentKind; json: string; updatedAt: number; revision: number; deleted: 0 | 1 }
export interface ContentListResult { ok: boolean; rows: ContentKvRow[]; revision: number; hasMore: boolean; error?: string }
export interface ContentCountsResult { ok: boolean; total: number; deleted: number; byKind: Record<string, number>; revision: number; error?: string }

function mapRow(row: Record<string, unknown>): ContentKvRow {
  return { key: String(row.key), kind: String(row.kind) as ContentKind, json: String(row.json ?? 'null'), updatedAt: Number(row.updated_at ?? 0), revision: Number(row.revision ?? 0), deleted: row.deleted ? 1 : 0 }
}

export async function readContentCounts(): Promise<ContentCountsResult> {
  const result = await sqliteCall({ method: 'contentCounts' as never, payload: {}, timeoutMs: TIMEOUT } as never) as { ok?: boolean; total?: number; deleted?: number; byKind?: Record<string, number>; revision?: number; message?: string }
  return { ok: result.ok !== false, total: Number(result.total ?? 0), deleted: Number(result.deleted ?? 0), byKind: result.byKind ?? {}, revision: Number(result.revision ?? 0), ...(result.ok === false ? { error: result.message ?? '读取内容计数失败' } : {}) }
}

export async function readContentRevision(): Promise<number> { return (await readContentCounts()).revision }

export async function listContentByRevision(sinceRevision = 0, limit = CONTENT_PAGE_SIZE): Promise<ContentListResult> {
  const result = await sqliteCall({ method: 'contentList' as never, payload: { fromRevision: sinceRevision, limit, orderBy: 'revision', direction: 'asc' }, timeoutMs: TIMEOUT } as never) as { ok?: boolean; rows?: Array<Record<string, unknown>>; revision?: number; hasMore?: boolean; message?: string }
  return { ok: result.ok !== false, rows: (result.rows ?? []).map(mapRow), revision: Number(result.revision ?? 0), hasMore: Boolean(result.hasMore), ...(result.ok === false ? { error: result.message ?? '内容读取失败' } : {}) }
}

/** 0.14 B-D2/迁移校验只读：按 key 排序 + offset 分页（可含 tombstone），返回 revision/kind/json/deleted 全字段快照 */
export async function listContentRowsPage(opts: { offset?: number; limit?: number; includeDeleted?: boolean; orderBy?: 'key' | 'revision' } = {}): Promise<ContentListResult> {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? CONTENT_PAGE_SIZE)))
  const payload = { ...(opts.offset !== undefined ? { offset: Math.max(0, Math.floor(opts.offset)) } : {}), limit, orderBy: opts.orderBy ?? 'key', direction: 'asc' as const, ...(opts.includeDeleted === false ? {} : { includeDeleted: true }) }
  const result = await sqliteCall({ method: 'contentList' as never, payload, timeoutMs: TIMEOUT } as never) as { ok?: boolean; rows?: Array<Record<string, unknown>>; revision?: number; hasMore?: boolean; message?: string }
  return { ok: result.ok !== false, rows: (result.rows ?? []).map(mapRow), revision: Number(result.revision ?? 0), hasMore: Boolean(result.hasMore), ...(result.ok === false ? { error: result.message ?? '内容读取失败' } : {}) }
}

/** 0.14 B-D2 写前快照只读：批量 contentGet（≤500 key/次），含已 tombstone 行 */
export async function readContentRows(keys: readonly string[]): Promise<{ ok: boolean; rows: ContentKvRow[]; error?: string }> {
  const rows: ContentKvRow[] = []
  try {
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500)
      const result = await sqliteCall({ method: 'contentGet' as never, payload: { keys: chunk }, timeoutMs: TIMEOUT } as never) as { ok?: boolean; rows?: Array<Record<string, unknown>>; message?: string }
      if (result.ok === false) return { ok: false, rows, error: result.message ?? '内容读取失败' }
      for (const row of result.rows ?? []) rows.push(mapRow(row))
    }
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, rows, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface ContentWriteInput { key: string; kind: ContentKind; json: string; updatedAt?: number; deleted?: boolean }

export async function writeContentRows(rows: readonly ContentWriteInput[]): Promise<{ ok: boolean; revision: number; error?: string }> {
  const upserts = rows.filter((row) => row.deleted !== true)
  const deletes = rows.filter((row) => row.deleted === true).map((row) => row.key)
  try {
    const expectedRevision = await readContentRevision()
    const result = await sqliteCall({
      method: 'contentWrite' as never,
      payload: { expectedRevision, entries: upserts.map((row) => ({ key: row.key, kind: row.kind, json: row.json, updated_at: row.updatedAt ?? Date.now() })), deletes },
      timeoutMs: 30_000,
    } as never) as { ok?: boolean; revision?: number; message?: string; code?: string }
    return { ok: result.ok !== false, revision: Number(result.revision ?? 0), ...(result.ok === false ? { error: `${result.code ?? ''} ${result.message ?? '内容写入失败'}`.trim() } : {}) }
  } catch (error) {
    return { ok: false, revision: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getContentRow(key: string): Promise<ContentKvRow | null> {
  const result = await sqliteCall({ method: 'contentGet' as never, payload: { keys: [key] }, timeoutMs: TIMEOUT } as never) as { ok?: boolean; rows?: Array<Record<string, unknown>>; message?: string }
  if (result.ok === false) throw new Error(result.message ?? '读取内容失败')
  return result.rows?.[0] ? mapRow(result.rows[0]) : null
}

export async function putContentRow(row: ContentWriteInput): Promise<number> {
  const result = await writeContentRows([row])
  if (!result.ok) throw new Error(result.error ?? '内容写入失败')
  return result.revision
}

export async function deleteContentRow(key: string, kind: ContentKind): Promise<number> {
  const result = await writeContentRows([{ key, kind, json: 'null', deleted: true }])
  if (!result.ok) throw new Error(result.error ?? '内容删除失败')
  return result.revision
}


/** F1：content_kv 需要 schema v3；旧库明确拒绝（不降级/不删库） */
export async function assertContentSchemaVersion(): Promise<{ ok: boolean; userVersion: number; error?: string }> {
  const health = await sqliteHealth(60_000)
  const userVersion = Number(health.userVersion ?? 0)
  if (userVersion < CONTENT_SCHEMA_VERSION) return { ok: false, userVersion, error: `SQLite schema v${userVersion} 过低，content_kv 需要 v${CONTENT_SCHEMA_VERSION}，请先迁移` }
  if (userVersion > CONTENT_SCHEMA_VERSION) return { ok: false, userVersion, error: `SQLite schema v${userVersion} 高于当前 App 支持 v${CONTENT_SCHEMA_VERSION}（E_DOWNGRADE），请升级 App，不删库` }
  return { ok: true, userVersion }
}

/** 0.17：从 APK 内置 seed 库一次性灌入 content_kv（原生单事务；失败整体回滚）。 */
export async function seedContentFromAsset(asset = 'pwa/seed/content.db'): Promise<{ ok: boolean; inserted: number; contentRows: number; revision: number; error?: string }> {
  try {
    const result = await sqliteCall({ method: 'contentSeed' as never, payload: { asset }, timeoutMs: 120_000 } as never) as { ok?: boolean; inserted?: number; contentRows?: number; revision?: number; message?: string }
    return { ok: result.ok !== false, inserted: Number(result.inserted ?? 0), contentRows: Number(result.contentRows ?? 0), revision: Number(result.revision ?? 0), ...(result.ok === false ? { error: result.message ?? 'seed 失败' } : {}) }
  } catch (error) {
    return { ok: false, inserted: 0, contentRows: 0, revision: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
