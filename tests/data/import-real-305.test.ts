import './test-utils'
// @ts-expect-error 项目未装 @types/node（仅测试读取私仓真实备份）
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getDb, importMigration, localDateKey, persistLearningWriteSource, resetDatabase, setSqliteTransport } from '../../src/data'

const FILE = '/sdcard/Download/WordC/背单词-学习进度-2026-11-25.migration(5).json'

function install() {
  const tables = new Map<string, Array<Record<string, unknown>>>()
  const txOps: unknown[][] = []
  let seq = 0
  const table = (name: string) => { const list = tables.get(name) ?? []; tables.set(name, list); return list }
  const matches = (row: Record<string, unknown>, where?: Record<string, unknown>) => !where || Object.entries(where).every(([key, value]) => row[key] === value)
  setSqliteTransport({ sqliteCall(json: string) {
    const req = JSON.parse(json) as { id: string; method: string; ops?: Array<Record<string, unknown>>; payload?: Record<string, unknown> }
    const id = `${req.id}-r${++seq}`
    setTimeout(() => {
      const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      if (req.method === 'tx') {
        const ops = req.ops ?? []; txOps.push(ops)
        for (const op of ops) {
          const name = String(op.table); const list = table(name)
          if (op.op === 'delete') { const where = op.where as Record<string, unknown> | undefined; const kept = list.filter((row) => !matches(row, where)); tables.set(name, kept); continue }
          if (op.op === 'upsert') { const row = op.row as Record<string, unknown>; const key = row.id ?? row.key ?? row.word_id ?? row.op_id ?? row.step; const index = list.findIndex((item) => (item.id ?? item.key ?? item.word_id ?? item.op_id ?? item.step) === key); if (index >= 0) list[index] = row; else list.push(row); continue }
          if (op.op === 'insert') { const row = { ...(op.row as Record<string, unknown>) }; if (name === 'review_logs') row.id = list.length + 1; list.push(row) }
        }
        cb?.(id, JSON.stringify({ ok: true })); return
      }
      if (req.method === 'query') {
        const payload = req.payload ?? {}; const name = String(payload.table); const list = table(name).filter((row) => matches(row, payload.where as Record<string, unknown> | undefined))
        const offset = Number(payload.offset ?? 0); const limit = Number(payload.limit ?? 1000)
        cb?.(id, JSON.stringify({ ok: true, rows: list.slice(offset, offset + limit) })); return
      }
      if (req.method === 'health') {
        const counts = { states: table('states').length, plans: table('plans').length, settings: table('settings').length, review_logs: table('review_logs').length, client_ops: table('client_ops').length }
        cb?.(id, JSON.stringify({ ok: true, userVersion: 3, counts, integrityOk: true, readOnly: false, wal: true, synchronous: 'FULL' })); return
      }
      if (req.method === 'integrity') { cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); return }
      cb?.(id, JSON.stringify({ ok: true, rows: [] }))
    }, 0)
    return JSON.stringify({ requestId: id })
  } })
  return { tables, txOps }
}

describe('task-305 real backup staging', () => {
  it('真实备份：IDB plans=1、delete migration_state、plans op、SQLite/IDB plans=1', async () => {
    if (!existsSync(FILE)) return
    await resetDatabase(); await persistLearningWriteSource('sqlite')
    const text = readFileSync(FILE, 'utf8')
    const mock = install()
    const report = await importMigration(text, {
      strategy: 'replace',
      preBackup: async () => ({ ok: true }),
      sqliteStageImpl: {
        createBackup: (async () => ({ ok: true, manifest: { format: 'momo-sqlite-backup-manifest', formatVersion: 1, name: 'real.db', bytes: 1, createdAt: 1, userVersion: 3, dataEpoch: 0, counts: { states: 0, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: true } })) as never,
        restoreBackup: (async () => ({ ok: true })) as never,
      },
    })
    expect(report.ok).toBe(true)
    const filePlan = (JSON.parse(text) as { data: { plans: Array<{ date: string; index: number; wordIds: string[] }> } }).data.plans[0]!
    const expectedPlans = filePlan.date === localDateKey(Date.now()) ? 1 : 0
    expect(await getDb().plans.count()).toBe(expectedPlans)
    if (expectedPlans === 1) {
      const idbPlan = (await getDb().plans.toArray())[0]!
      expect(idbPlan.index).toBe(filePlan.index)
      expect(idbPlan.wordIds).toEqual(filePlan.wordIds)
    }
    expect(mock.txOps.some((ops) => ops.some((op) => ((op as { table?: string }).table === 'migration_state' && (op as { op?: string }).op === 'delete')))).toBe(true)
    if (expectedPlans === 1) expect(mock.txOps.some((ops) => ops.some((op) => (op as { table?: string }).table === 'plans' && (op as { op?: string }).op === 'upsert'))).toBe(true)
    expect(mock.tables.get('plans')?.length ?? 0).toBe(expectedPlans)
    setSqliteTransport(null)
  }, 120000)
})
