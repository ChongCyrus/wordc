/**
 * data 层测试公共工具。
 *
 * ⚠️ 第一行 `import 'fake-indexeddb/auto'` 必须在任何 `src/data` import 之前求值，
 * 否则 Node 环境没有全局 indexedDB，Dexie 打开数据库会失败。因此所有 data 测试
 * **第一个 import 都是本文件**。
 */

import 'fake-indexeddb/auto'
import {
  ensureBuiltinDecks,
  getDb,
  resetDatabase,
} from '../../src/data'

export { ensureBuiltinDecks, getDb, resetDatabase }

/** 每个测试前重置数据库（fake-indexeddb 是进程内存储，测试文件之间互相隔离） */
export async function freshDb(): Promise<void> {
  await resetDatabase()
}

/** 种子内置词库（返回种子结果） */
export async function seedBuiltin() {
  return ensureBuiltinDecks()
}

/** 取某词库前 N 个未学词条（测试用） */
export async function firstWords(deckId: string, limit: number) {
  const db = getDb()
  return db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .limit(limit)
    .toArray()
}

/**
 * 0.15/0.16 内容写源测试辅助（task-312 C-04 之后的必需品）。
 *
 * `getContentWriteSource()` 在 Node 测试环境走 0.14 legacy 语义（读 settings），
 * 而 `getSettings()` → `readSettingsThroughCache()` 在 IDB cache meta 缺失时 **fail-closed 回源 SQLite**；
 * tests 里 mock 的 SQLite 通常只回答 `rows: []`，于是 `data.contentWriteSource='sqlite'` 读不回来，
 * 写源被判成 idb —— 0.14 时代只调 `persistContentWriteSource('sqlite')` 的用例因此集体失效。
 *
 * 本 helper 等价于“已在 sqlite 写源的运行中设备”：写 settings 镜像 + 置 cache meta ready。
 * 只在测试里使用；生产由 `restoreLearningWriteSource` / v15 门禁负责。
 */
export async function primeLegacySqliteContentSource(): Promise<void> {
  const { persistContentWriteSource } = await import('../../src/data/content-write-source')
  const { primeM2ReadCacheForTests, SQLITE_SCHEMA_VERSION } = await import('../../src/data')
  await persistContentWriteSource('sqlite')
  await primeM2ReadCacheForTests({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false })
}

/**
 * 与 primeLegacySqliteContentSource 成对使用：清掉 sqlite 写源镜像与 cache meta，
 * 让后续「idb 模式」用例回到干净的 idb 写源（cache meta 是 IDB meta 行，只有 resetDatabase 才清）。
 */
export async function resetContentSourceToIdb(): Promise<void> {
  const { persistContentWriteSource } = await import('../../src/data/content-write-source')
  const { getDb } = await import('../../src/data')
  await persistContentWriteSource('idb')
  const { IDB_CACHE_META_KEY } = await import('../../src/data/idb-cache')
  await getDb().meta.delete(IDB_CACHE_META_KEY).catch(() => undefined)
}

/**
 * 只置 IDB cache meta ready（不动内容写源）。
 * C-04 后 `getSettings()` 在 meta 缺失时 fail-closed 回源 SQLite；mock SQLite 通常返回空行，
 * 于是「刚写进 IDB settings」的用例会读到默认值（如 contentWriteSource 仍是 idb）。
 * 需要断言 IDB settings 的用例在 resetDatabase 后调用本函数即可。
 */
export async function primeIdbCacheReady(): Promise<void> {
  const { primeM2ReadCacheForTests, SQLITE_SCHEMA_VERSION } = await import('../../src/data')
  await primeM2ReadCacheForTests({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false })
}
