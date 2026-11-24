/** 0.11.0 M5：SQLite facts checkpoint（states/plans/settings），latest+3，仅 SQLite states=0 恢复 */
import { getDataEpoch } from './data-epoch'
import { isSqliteAvailable, sqliteHealth, sqliteQuery, sqliteTx } from './native-sqlite'
import { SQLITE_SCHEMA_VERSION } from './sqlite-store'
import type { AutoBackupBridge } from './auto-backup'

export const SQLITE_CHECKPOINT_LATEST = 'sqlite-checkpoint-latest.state.json'
export const SQLITE_CHECKPOINT_KEEP = 3
export interface SqliteFactsCheckpoint {
  format: 'momo-sqlite-checkpoint'
  formatVersion: 1
  createdAt: number
  dataEpoch: number
  userVersion: number
  counts: { states: number; plans: number; settings: number }
  states: unknown[]
  plans: unknown[]
  settings: unknown[]
}
const names = () => [SQLITE_CHECKPOINT_LATEST, ...Array.from({ length: SQLITE_CHECKPOINT_KEEP }, (_, i) => `sqlite-checkpoint-${i + 1}.state.json`)]
let timer: ReturnType<typeof setTimeout> | null = null
let scheduledBridge: AutoBackupBridge | null = null

async function queryAll(table: string, key: string, limit = 500): Promise<unknown[]> {
  const out: unknown[] = []
  const seen = new Set<string>()
  for (let offset = 0; offset < 1_000_000; offset += limit) {
    const response = await sqliteQuery({ table, limit, offset, orderBy: key, direction: 'asc' }, 5_000)
    if (response.ok === false) throw new Error((response as { message?: string }).message ?? `query ${table} 失败`)
    const page = (response.rows as Array<Record<string, unknown>> | undefined) ?? []
    let added = 0
    for (const row of page) {
      const id = String(row[key] ?? '')
      if (seen.has(id)) continue
      seen.add(id)
      out.push(row)
      added += 1
    }
    if (page.length < limit) break
    if (added === 0) throw new Error(`checkpoint ${table} 分页未生效`)
  }
  return out
}

export async function buildSqliteFactsCheckpoint(): Promise<SqliteFactsCheckpoint | null> {
  if (!isSqliteAvailable()) return null
  const health = await sqliteHealth(5_000)
  if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) return null
  const counts = (health as unknown as { counts?: Record<string, number> }).counts
  if (!counts) return null
  if (Number(counts.states ?? 0) === 0) return null
  const [states, plans, settings] = await Promise.all([
    queryAll('states', 'word_id'),
    queryAll('plans', 'id'),
    queryAll('settings', 'key'),
  ])
  return {
    format: 'momo-sqlite-checkpoint',
    formatVersion: 1,
    createdAt: Date.now(),
    dataEpoch: await getDataEpoch(),
    userVersion: Number(health.userVersion ?? 0),
    counts: { states: states.length, plans: plans.length, settings: settings.length },
    states,
    plans,
    settings,
  }
}

export async function saveSqliteFactsCheckpoint(bridge: AutoBackupBridge): Promise<boolean> {
  try {
    if (!bridge.isAvailable()) return false
    const checkpoint = await buildSqliteFactsCheckpoint()
    if (!checkpoint) return false
    const text = JSON.stringify(checkpoint)
    if (text.length < 2) return false
    const existing = bridge.list().map((entry) => entry.name)
    if (existing.includes(SQLITE_CHECKPOINT_LATEST)) {
      for (let i = SQLITE_CHECKPOINT_KEEP; i >= 1; i -= 1) {
        const source = i === 1 ? SQLITE_CHECKPOINT_LATEST : `sqlite-checkpoint-${i - 1}.state.json`
        const target = `sqlite-checkpoint-${i}.state.json`
        const content = bridge.read(source)
        if (content != null) {
          const saved = await bridge.save(content, target)
          if (!saved.ok) return false
        }
      }
    }
    return (await bridge.save(text, SQLITE_CHECKPOINT_LATEST)).ok
  } catch {
    return false
  }
}

export function scheduleSqliteFactsCheckpoint(bridge: AutoBackupBridge, delayMs = 2000): void {
  scheduledBridge = bridge
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void saveSqliteFactsCheckpoint(bridge)
  }, Math.max(0, delayMs))
}

export async function flushSqliteFactsCheckpoint(bridge?: AutoBackupBridge): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  const target = bridge ?? scheduledBridge
  if (target) await saveSqliteFactsCheckpoint(target)
}

export async function restoreSqliteFactsCheckpointIfEmpty(bridge: AutoBackupBridge): Promise<{ ok: boolean; restoredStates?: number; error?: string }> {
  if (!bridge.isAvailable()) return { ok: false, error: '自动备份不可用' }
  const health = await sqliteHealth(5_000)
  const currentStates = Number((health as unknown as { counts?: Record<string, number> }).counts?.states ?? 0)
  if (currentStates > 0) return { ok: false, error: 'SQLite states 非空，不自动恢复' }
  const text = bridge.read(SQLITE_CHECKPOINT_LATEST)
  if (!text) return { ok: false, error: '无检查点' }
  try {
    const checkpoint = JSON.parse(text) as SqliteFactsCheckpoint
    if (checkpoint.format !== 'momo-sqlite-checkpoint' || !Array.isArray(checkpoint.states)) return { ok: false, error: '检查点格式无效' }
    const ops: unknown[] = []
    for (const row of checkpoint.states) ops.push({ op: 'upsert', table: 'states', row })
    for (const row of checkpoint.plans) ops.push({ op: 'upsert', table: 'plans', row })
    for (const row of checkpoint.settings) ops.push({ op: 'upsert', table: 'settings', row })
    const tx = await sqliteTx(ops)
    if (tx.ok === false) return { ok: false, error: tx.message ?? '恢复写入失败' }
    const after = await sqliteHealth(5_000)
    const restoredStates = Number((after as unknown as { counts?: Record<string, number> }).counts?.states ?? 0)
    return { ok: true, restoredStates }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 清空数据时删除所有 SQLite checkpoint 文件 */
export async function deleteSqliteFactsCheckpoints(bridge: AutoBackupBridge): Promise<number> {
  if (!bridge.isAvailable()) return 0
  let deleted = 0
  for (const name of names()) if (bridge.delete(name)) deleted += 1
  return deleted
}

let autoBridge: AutoBackupBridge | null = null
/** App 启动注册：评分/plan 写成功后自动 2s checkpoint */
export function setSqliteFactsCheckpointBridge(bridge: AutoBackupBridge | null): void {
  autoBridge = bridge
  if (bridge) setTimeout(() => { void saveSqliteFactsCheckpoint(bridge) }, 0)
}
export function notifySqliteFactsChanged(delayMs = 2000): void {
  if (autoBridge) scheduleSqliteFactsCheckpoint(autoBridge, delayMs)
}
export async function flushSqliteFactsCheckpointAuto(): Promise<void> {
  if (autoBridge) await flushSqliteFactsCheckpoint(autoBridge)
}


/** UI：最近 SQLite checkpoint 状态 */
export async function getSqliteCheckpointStatus(bridge?: AutoBackupBridge): Promise<{ available: boolean; latestAt?: number; counts?: { states: number; plans: number; settings: number }; error?: string }> {
  try {
    const target = bridge ?? autoBridge
    if (!target?.isAvailable()) return { available: false, error: '检查点未初始化（后台初始化中）' }
    const text = target.read(SQLITE_CHECKPOINT_LATEST)
    if (!text) return { available: false, error: '暂无 SQLite 检查点（评分后自动保存）' }
    const checkpoint = JSON.parse(text) as SqliteFactsCheckpoint
    return { available: true, latestAt: checkpoint.createdAt, counts: checkpoint.counts }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  }
}
