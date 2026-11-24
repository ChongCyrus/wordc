/** 0.11.0 M1：异步 SQLite bridge/DDL/dirty 回源/迁移骨架 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SQLITE_DDL,
  SQLITE_SCHEMA_VERSION,
  ensureSqliteSchema,
  getIdbCacheMeta,
  markIdbCacheDirty,
  migrateIdbToSqlite,
  readThroughIdbCache,
  rebuildIdbCache,
  setSqliteTransport,
  sqliteCall,
  type SqliteTransport,
} from '../../src/data'

function makeTransport(): { transport: SqliteTransport; queue: Array<{ requestId: string; respond: (json: string) => void }> } {
  const queue: Array<{ requestId: string; respond: (json: string) => void }> = []
  let seq = 0
  const transport: SqliteTransport = {
    sqliteCall(reqJson) {
      const req = JSON.parse(reqJson) as { id: string }
      seq += 1
      const requestId = `${req.id}-r${seq}`
      queue.push({
        requestId,
        respond: (json) => {
          const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          callback?.(requestId, json)
        },
      })
      return JSON.stringify({ requestId })
    },
    sqliteCancel() { return '{"ok":true}' },
  }
  return { transport, queue }
}

afterEach(() => setSqliteTransport(null))
async function waitForQueue(queue: Array<unknown>, length: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (queue.length >= length) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`queue 未达到 ${length}，实际 ${queue.length}`)
}

describe('0.11.0 · native sqlite M1', () => {
  it('异步 requestId/Promise 成功、错误码、超时 cancel', async () => {
    const { transport, queue } = makeTransport()
    setSqliteTransport(transport)
    const promise = sqliteCall({ method: 'health', timeoutMs: 2_000 })
    await waitForQueue(queue, 1)
    expect(queue).toHaveLength(1)
    queue[0]!.respond(JSON.stringify({ ok: true, userVersion: 1, wal: true, synchronous: 'FULL' }))
    await expect(promise).resolves.toMatchObject({ ok: true, userVersion: 1 })
    // 错误码
    const failed = sqliteCall({ method: 'exec', ops: [] })
    await waitForQueue(queue, 2)
    queue[1]!.respond(JSON.stringify({ ok: false, code: 'E_QUOTA', message: 'disk full' }))
    await expect(failed).rejects.toMatchObject({ code: 'E_QUOTA' })
    // 超时 + cancel
    const cancelled: string[] = []
    setSqliteTransport({ ...transport, sqliteCancel: (id) => { cancelled.push(id); return '{"ok":true}' } })
    const timeout = sqliteCall({ method: 'query', timeoutMs: 1000 })
    await expect(timeout).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    expect(cancelled.length).toBe(1)
  })

  it('SQLite 调用严格串行；E_BUSY 指数退避重试', async () => {
    const { transport, queue } = makeTransport()
    setSqliteTransport(transport)
    const first = sqliteCall({ method: 'health' })
    const second = sqliteCall({ method: 'query', payload: { table: 'states' } })
    await waitForQueue(queue, 1)
    expect(queue).toHaveLength(1) // 第二个必须等第一个完成
    queue[0]!.respond(JSON.stringify({ ok: true, userVersion: 2 }))
    await expect(first).resolves.toMatchObject({ ok: true })
    await waitForQueue(queue, 2)
    expect(queue).toHaveLength(2)
    queue[1]!.respond(JSON.stringify({ ok: true, rows: [] }))
    await expect(second).resolves.toMatchObject({ ok: true })
    // E_BUSY 首次失败 → 退避重试成功
    const busy = sqliteCall({ method: 'health' })
    await waitForQueue(queue, 3)
    queue[2]!.respond(JSON.stringify({ ok: false, code: 'E_BUSY', message: 'database is locked' }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(queue.length).toBeGreaterThanOrEqual(4)
    queue[3]!.respond(JSON.stringify({ ok: true, userVersion: 2 }))
    await expect(busy).resolves.toMatchObject({ ok: true, userVersion: 2 })
  })

  it('DDL v2 / user_version 降级保护；user_version=0 不允许 sql op', async () => {
    expect(SQLITE_DDL.join('\n')).toContain('CREATE TABLE IF NOT EXISTS states')
    expect(SQLITE_DDL.join('\n')).toContain('review_logs')
    expect(SQLITE_DDL.join('\n')).toContain('client_ops')
    expect(SQLITE_DDL.join('\n')).toContain('client_op_id')
    expect(SQLITE_DDL.join('\n')).toContain(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`)
    const { transport, queue } = makeTransport()
    setSqliteTransport(transport)
    const v0 = ensureSqliteSchema()
    await waitForQueue(queue, 1)
    queue[0]!.respond(JSON.stringify({ ok: true, userVersion: 0, wal: true, synchronous: 'FULL', readOnly: false }))
    await expect(v0).rejects.toThrow(/未初始化/)
    // 高版本只读拒绝
    const high = ensureSqliteSchema()
    await waitForQueue(queue, 2)
    queue[1]!.respond(JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION + 1, wal: true, synchronous: 'FULL', readOnly: false }))
    await expect(high).rejects.toThrow(/版本过高/)
  })

  it('IDB dirty 回源 SQLite；重建后 ready', async () => {
    await markIdbCacheDirty('test')
    let cacheReads = 0
    const read = await readThroughIdbCache({
      generation: 1,
      sqliteUserVersion: SQLITE_SCHEMA_VERSION,
      cacheRead: async () => { cacheReads += 1; return 'cache' },
      sqliteRead: async () => 'sqlite',
    })
    expect(read).toEqual({ value: 'sqlite', source: 'sqlite' })
    expect(cacheReads).toBe(0)
    const meta = await rebuildIdbCache({
      generation: 1,
      sqliteUserVersion: SQLITE_SCHEMA_VERSION,
      rebuildTable: async () => 1,
    })
    expect(meta.dirty).toBe(false)
    expect(await getIdbCacheMeta()).toMatchObject({ generation: 1, dirty: false })
    const clean = await readThroughIdbCache({
      generation: 1,
      sqliteUserVersion: SQLITE_SCHEMA_VERSION,
      cacheRead: async () => 'cache',
      sqliteRead: async () => 'sqlite',
    })
    expect(clean).toEqual({ value: 'cache', source: 'cache' })
  })

  it('迁移骨架 dryRun 计数、不写 SQLite', async () => {
    const result = await migrateIdbToSqlite({ dryRun: true, batchSize: 50 })
    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.counts.settings).toBeGreaterThanOrEqual(0)

  })
})
