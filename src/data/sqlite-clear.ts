/** 0.11.0 A1：SQLite facts 全量清除（供 clearAllData sqlite 模式） */
import { isSqliteAvailable, sqliteQuery, sqliteTx } from './native-sqlite'

const TABLES: Array<{ table: string; key: string }> = [
  { table: 'states', key: 'word_id' },
  { table: 'plans', key: 'id' },
  { table: 'settings', key: 'key' },
  { table: 'review_logs', key: 'id' },
  { table: 'client_ops', key: 'op_id' },
  { table: 'migration_state', key: 'step' },
]

async function allKeys(table: string, key: string): Promise<string[]> {
  const keys: string[] = []
  const seen = new Set<string>()
  for (let offset = 0; offset < 1_000_000; offset += 500) {
    const response = await sqliteQuery({ table, limit: 500, offset, orderBy: key, direction: 'asc' }, 5_000)
    if (response.ok === false) throw new Error((response as { message?: string }).message ?? `query ${table} 失败`)
    const page = (response.rows as Array<Record<string, unknown>> | undefined) ?? []
    for (const row of page) {
      const id = String(row[key] ?? '')
      if (id && !seen.has(id)) { seen.add(id); keys.push(id) }
    }
    if (page.length < 500) break
  }
  return keys
}

/** 单 tx 清 facts/migration_state/client_ops；失败回滚 */
export async function clearAllSqliteFacts(): Promise<void> {
  if (!isSqliteAvailable()) throw new Error('SQLite 不可用')
  const ops: unknown[] = []
  for (const { table, key } of TABLES) {
    const keys = await allKeys(table, key)
    for (const value of keys) ops.push({ op: 'delete', table, where: { [key]: value } })
  }
  if (ops.length === 0) return
  const tx = await sqliteTx(ops)
  if (tx.ok === false) throw new Error(tx.message ?? 'SQLite 清空事务失败')
}


/** 清空指定 facts 表（保留 settings/migration_state/client_ops），用于 facts-only 导入 replace。 */
export async function clearSqliteFactsTables(tables: Array<'states' | 'plans' | 'review_logs'>): Promise<void> {
  if (!isSqliteAvailable()) throw new Error('SQLite 不可用')
  if (tables.length === 0) return
  // P1-10：facts 三表用单 tx + all:true 原子清空（native 白名单仅 states/plans/review_logs）
  const ops = tables.map((table) => ({ op: 'delete', table, all: true }))
  const tx = await sqliteTx(ops)
  if (tx.ok === false) throw new Error(tx.message ?? `SQLite 清空 ${tables.join('/')} 失败`)
}
