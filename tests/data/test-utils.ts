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
