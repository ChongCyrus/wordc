/** 0.11.0 M4b-0：schema v2 校验/备份/cache meta 升 2 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureM4b0Schema,
  getIdbCacheMeta,
  getDataEpoch,
  primeM2ReadCacheForTests,
  setSqliteTransport,
  SQLITE_DDL,
  SQLITE_SCHEMA_VERSION,
  type SqliteTransport,
} from '../../src/data'

const counts = { states: 241, plans: 1, settings: 11, review_logs: 0 }

function install(opts: { version?: number; counts?: Record<string, number>; migration?: string; healthFail?: boolean } = {}) {
  let seq = 0
  const calls: string[] = []
  const transport: SqliteTransport = {
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }
      calls.push(req.method)
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') {
          callback?.(id, JSON.stringify({
            ok: true,
            userVersion: opts.version ?? SQLITE_SCHEMA_VERSION,
            counts: opts.counts ?? counts,
            wal: true,
            synchronous: 'FULL',
            readOnly: false,
            integrityOk: true,
          }))
          return
        }
        if (req.payload?.table === 'migration_state') {
          callback?.(id, JSON.stringify({ ok: true, rows: [{ step: 'legacy-idb', status: opts.migration ?? 'done' }] }))
          return
        }
        callback?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  }
  setSqliteTransport(transport)
  return { calls }
}

afterEach(() => setSqliteTransport(null))

describe('0.11.0 · M4b-0 schema v2', () => {
  it('v2 DDL 幂等包含 client_ops/client_op_id+唯一索引；门禁通过并升 cache meta=2', async () => {
    const ddl = SQLITE_DDL.join('\n')
    expect(SQLITE_SCHEMA_VERSION).toBe(3)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS client_ops')
    expect(ddl).toContain('client_op_id TEXT')
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_client_op')
    await primeM2ReadCacheForTests({ generation: await getDataEpoch(), sqliteUserVersion: 1 })
    const mock = install()
    let backups = 0
    const result = await ensureM4b0Schema({
      preBackup: async () => { backups += 1; return { ok: true } },
      expectedCounts: { states: 241, plans: 1, settings: 11, reviewLogs: 0 },
    })
    expect(result.ok).toBe(true)
    expect(result.userVersion).toBe(3)
    expect(result.counts).toEqual({ states: 241, plans: 1, settings: 11, reviewLogs: 0 })
    expect(backups).toBe(1)
    expect(mock.calls).toEqual(['health', 'query'])
    expect(await getIdbCacheMeta()).toMatchObject({ sqliteUserVersion: 3, dirty: false })
    // 重复执行：仍通过，不执行 DDL/ALTER
    const again = await ensureM4b0Schema({ expectedCounts: { states: 241, plans: 1, settings: 11, reviewLogs: 0 } })
    expect(again.ok).toBe(true)
    expect(await getIdbCacheMeta()).toMatchObject({ sqliteUserVersion: 3, dirty: false })
  })

  it('备份失败拒绝；v1 未升级拒绝；counts 变化拒绝；migration 未 done 拒绝', async () => {
    install()
    const failBackup = await ensureM4b0Schema({ preBackup: async () => ({ ok: false, error: 'mock' }) })
    expect(failBackup.ok).toBe(false)
    expect(failBackup.error).toMatch(/备份/)
    const v1 = await ensureM4b0Schema({ unsafe: true })
    // 当前 mock version=2，改为 v1 需要重新 install
    expect(v1.ok).toBe(true)
    setSqliteTransport(null)
    install({ version: 1 })
    const old = await ensureM4b0Schema({ unsafe: true })
    expect(old.ok).toBe(false)
    expect(old.error).toMatch(/仍为 v1/)
    setSqliteTransport(null)
    install({ counts: { ...counts, states: 240 } })
    const changed = await ensureM4b0Schema({ unsafe: true, expectedCounts: { states: 241, plans: 1, settings: 11, reviewLogs: 0 } })
    expect(changed.ok).toBe(false)
    expect(changed.error).toMatch(/counts/)
    setSqliteTransport(null)
    install({ migration: 'running' })
    const notDone = await ensureM4b0Schema({ unsafe: true })
    expect(notDone.ok).toBe(false)
    expect(notDone.error).toMatch(/migration_state/)
  })
})
