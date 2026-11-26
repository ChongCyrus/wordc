import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { clearAllSqliteFacts, setSqliteTransport } from '../../src/data'

afterEach(() => setSqliteTransport(null))

/** P0-1：>500 行也不能再拼成单个 tx；facts 用 all:true，其余表 ≤400/批。 */
describe('P0-1 clearAllSqliteFacts 分批', () => {
  it('600 rows/table 不超 500 ops，facts 用 all:true，其余 ≤400/批', async () => {
    const txBatches: unknown[][] = []
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; tx?: boolean; ops?: unknown[]; payload?: { table?: string; offset?: number } }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'tx') {
            txBatches.push(req.ops ?? [])
            cb?.(id, JSON.stringify({ ok: true }))
            return
          }
          if (req.method === 'query') {
            const table = req.payload?.table ?? ''
            const offset = Number(req.payload?.offset ?? 0)
            const total = 600
            const count = Math.max(0, Math.min(500, total - offset))
            const key = table === 'settings' ? 'key' : table === 'client_ops' ? 'op_id' : 'step'
            const rows = Array.from({ length: count }, (_, i) => ({ [key]: `${table}-${offset + i}` }))
            cb?.(id, JSON.stringify({ ok: true, rows }))
            return
          }
          cb?.(id, JSON.stringify({ ok: true }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    await clearAllSqliteFacts()
    expect(txBatches[0]!.map((op) => (op as { all?: boolean }).all)).toEqual([true, true, true])
    for (const batch of txBatches) expect(batch.length).toBeLessThanOrEqual(400)
    // 3 facts 一次 + settings/client_ops/migration_state 各 2 批 = 7
    expect(txBatches.length).toBe(7)
  })
})

import { clearAllData, getDb, persistLearningWriteSource, resetDatabase } from '../../src/data'

describe('P0-1 clearAllData safety snapshot 回滚', () => {
  it('SQLite 清空失败时从 safety snapshot 回滚，不留下半清空', async () => {
    await resetDatabase()
    await persistLearningWriteSource('sqlite')
    let seq = 0
    let restoreCalls = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 3, counts: { states: 0, plans: 0, settings: 0, review_logs: 0 }, integrityOk: true, readOnly: false }))
          else if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, bytes: 4096, name: 'sqlite-backup-safety.db', path: '/p/safety.db', checksum: 'x' }))
          else if (req.method === 'restoreDb') { restoreCalls += 1; cb?.(id, JSON.stringify({ ok: true })) }
          else if (req.method === 'tx') cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock clear fail' }))
          else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true }))
          else if (req.method === 'query' && (req as unknown as { payload?: { table?: string } }).payload?.table === 'migration_state') cb?.(id, JSON.stringify({ ok: true, rows: [{ step: 'content-v15', status: 'done' }] }))
          else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    await expect(clearAllData({ preBackup: async () => ({ ok: true }) })).rejects.toThrow(/已从安全快照回滚/)
    expect(restoreCalls).toBeGreaterThanOrEqual(1)
    expect(await getDb().states.count()).toBe(0)
  })
})
