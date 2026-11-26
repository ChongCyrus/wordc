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

/** 清 facts/migration_state/client_ops：facts 三表 all:true 单语句，其余按 ≤400/批；失败回滚（由调用方 safety snapshot 恢复）。 */
export async function clearAllSqliteFacts(): Promise<void> {
  if (!isSqliteAvailable()) throw new Error('SQLite 不可用')
  // P0-1：states/plans/review_logs 用 native all:true，避免 255 states + 791 logs 超过 MAX_OPS=500。
  const factTx = await sqliteTx([
    { op: 'delete', table: 'states', all: true },
    { op: 'delete', table: 'plans', all: true },
    { op: 'delete', table: 'review_logs', all: true },
  ])
  if (factTx.ok === false) throw new Error(factTx.message ?? 'SQLite 清 facts 事务失败')
  // settings/client_ops/migration_state：按 key 分批，每批 ≤400（native 上限 500）。
  for (const { table, key } of TABLES.filter((item) => item.table === 'settings' || item.table === 'client_ops' || item.table === 'migration_state')) {
    const keys = await allKeys(table, key)
    for (let i = 0; i < keys.length; i += 400) {
      const ops = keys.slice(i, i + 400).map((value) => ({ op: 'delete', table, where: { [key]: value } }))
      const tx = await sqliteTx(ops)
      if (tx.ok === false) throw new Error(tx.message ?? `SQLite 清 ${table} 事务失败`)
    }
  }
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
