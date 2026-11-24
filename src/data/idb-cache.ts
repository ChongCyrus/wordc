/** 0.11.0 M1：IndexedDB 读缓存 generation/dirty/回源（SQLite 是事实源） */
import { getDb } from './db'
import { getDataEpoch } from './data-epoch'

export const IDB_CACHE_META_KEY = 'sqlite.idbCache'

export interface IdbCacheMeta {
  generation: number
  sqliteUserVersion: number
  rebuiltAt?: number
  dirty: boolean
  dirtyAt?: number
  reason?: string
}

export async function getIdbCacheMeta(): Promise<IdbCacheMeta | null> {
  const row = await getDb().meta.get(IDB_CACHE_META_KEY)
  const value = row?.value as IdbCacheMeta | undefined
  if (!value) return null
  return {
    generation: Number(value.generation ?? 0),
    sqliteUserVersion: Number(value.sqliteUserVersion ?? 0),
    dirty: value.dirty === true,
    ...(value.rebuiltAt != null ? { rebuiltAt: value.rebuiltAt } : {}),
    ...(value.dirtyAt != null ? { dirtyAt: value.dirtyAt } : {}),
    ...(value.reason ? { reason: value.reason } : {}),
  }
}

export async function writeIdbCacheMeta(meta: IdbCacheMeta): Promise<void> {
  await getDb().meta.put({ key: IDB_CACHE_META_KEY, value: meta, updatedAt: Date.now() })
}

export async function markIdbCacheDirty(reason: string): Promise<void> {
  const existing = (await getIdbCacheMeta()) ?? { generation: 0, sqliteUserVersion: 0, dirty: false }
  await writeIdbCacheMeta({ ...existing, dirty: true, dirtyAt: Date.now(), reason })
}

export async function clearIdbCacheDirty(meta: IdbCacheMeta): Promise<void> {
  await writeIdbCacheMeta({ ...meta, dirty: false, rebuiltAt: Date.now() })
}

/** 缓存的 generation 是否仍与 SQLite/epoch 一致 */
export async function isIdbCacheStale(expected: { generation: number; sqliteUserVersion: number }): Promise<boolean> {
  const meta = await getIdbCacheMeta()
  if (!meta) return true
  return meta.dirty || meta.generation !== expected.generation || meta.sqliteUserVersion !== expected.sqliteUserVersion
}

export interface ReadThroughOptions<T> {
  cacheRead: () => Promise<T | null>
  sqliteRead: () => Promise<T>
  generation: number
  sqliteUserVersion: number
}

/** dirty/版本不一致 → 回源 SQLite；不把 stale cache 当事实 */
export async function readThroughIdbCache<T>(opts: ReadThroughOptions<T>): Promise<{ value: T; source: 'cache' | 'sqlite' }> {
  const stale = await isIdbCacheStale({ generation: opts.generation, sqliteUserVersion: opts.sqliteUserVersion })
  if (!stale) {
    const cached = await opts.cacheRead()
    if (cached != null) return { value: cached, source: 'cache' }
  }
  const value = await opts.sqliteRead()
  return { value, source: 'sqlite' }
}

export interface RebuildIdbCacheInput {
  generation: number
  sqliteUserVersion: number
  /** 分页从 SQLite 拉取并写 cache；返回写入数 */
  rebuildTable: (table: 'states' | 'plans' | 'settings' | 'review_logs') => Promise<number>
  onProgress?: (progress: { table: string; done: number }) => void
}

/** M1 骨架：按表重建；words/decks 由 assets 重建，不在此处 */
export async function rebuildIdbCache(input: RebuildIdbCacheInput): Promise<IdbCacheMeta> {
  const tables: Array<'states' | 'plans' | 'settings' | 'review_logs'> = ['settings', 'states', 'plans', 'review_logs']
  let done = 0
  for (const table of tables) {
    done += await input.rebuildTable(table)
    input.onProgress?.({ table, done })
  }
  const meta: IdbCacheMeta = {
    generation: input.generation,
    sqliteUserVersion: input.sqliteUserVersion,
    rebuiltAt: Date.now(),
    dirty: false,
  }
  await writeIdbCacheMeta(meta)
  return meta
}

/** 当前 cache 是否可直接用（供启动流程） */
export async function idbCacheReady(expected: { generation: number; sqliteUserVersion: number }): Promise<boolean> {
  return !(await isIdbCacheStale(expected))
}

/** 诊断：cache 与 data epoch 摘要 */
export async function getIdbCacheDiagnostics(): Promise<{
  meta: IdbCacheMeta | null
  dataEpoch: number
}> {
  return { meta: await getIdbCacheMeta(), dataEpoch: await getDataEpoch() }
}
