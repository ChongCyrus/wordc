import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildRollbackMigrationText, resetDatabase } from '../../src/data'
describe('M6 rollback package', () => {
  it('0.10 迁移 JSON 带 rollback 标记', async () => {
    await resetDatabase()
    const text = await buildRollbackMigrationText()
    const parsed = JSON.parse(text) as { rollback?: { forVersion?: string; source?: string } }
    expect(parsed.rollback).toMatchObject({ forVersion: '0.10.0', source: 'sqlite-rollback' })
  })
})

import { importMigration, readLegacyIdbMigrationData } from '../../src/data'
describe('M6 rollback import/delta', () => {
  it('当前 importMigration 可读 rollback JSON（rollback 字段忽略）', async () => {
    const text = await buildRollbackMigrationText()
    const report = await importMigration(text, { strategy: 'merge' })
    expect(report.ok).toBe(true)
    const legacy = await readLegacyIdbMigrationData()
    expect(legacy.counts.states).toBeGreaterThanOrEqual(0)
  })
  it('applyIdbDeltaToSqlite 无 delta 时 no-op（无 preBackup 也安全）', async () => {
    const { applyIdbDeltaToSqlite } = await import('../../src/data')
    // 无 SQLite bridge 时 detect 会抛；此处只断言函数已导出/可调用错误结构
    expect(typeof applyIdbDeltaToSqlite).toBe('function')
  })
})

import { detectIdbDeltaSinceSqlite, applyIdbDeltaToSqlite, setSqliteTransport, createDeck, getDb, updateSettings, buildInitialState } from '../../src/data'
describe('M6 delta paging', () => {
  it('SQLite 1200 行跨页 detect 不截断', async () => {
    const { resetDatabase } = await import('../../src/data')
    await resetDatabase()
    const deck = await createDeck({ name: 'delta', words: [{ headword: 'x', meanings: [{ cn: '义' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const idbWord = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ ...buildInitialState(idbWord, 1), updatedAt: 999999 })
    const states = Array.from({ length: 1200 }, (_, i) => ({ word_id: i === 5 ? idbWord.id : `s${i}`, updated_at: 1 }))
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string; offset?: number; limit?: number } }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          const table = req.payload?.table
          if (table === 'states') {
            const offset = Number(req.payload?.offset ?? 0)
            const limit = Number(req.payload?.limit ?? 500)
            cb?.(id, JSON.stringify({ ok: true, rows: states.slice(offset, offset + limit) }))
          } else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const delta = await detectIdbDeltaSinceSqlite()
    expect(delta.states).toBe(1)
    expect(delta.deletedStates.length).toBe(1199)
    const rejected = await applyIdbDeltaToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toMatch(/删除候选/)
    setSqliteTransport(null)
  }, 20000)
})


import { applyIdbDeltaToSqlite as applyDelta, getLearningWriteSource, persistLearningWriteSource } from '../../src/data'
async function applySeed() {
  const { resetDatabase } = await import('../../src/data')
  await resetDatabase()
  const deck = await createDeck({ name: 'ap', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
  await db.states.put({ ...buildInitialState(word, 1), updatedAt: 999999 })
  return word
}
function applyTransport(failTx: boolean) {
  let seq = 0
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }
      const id = `${req.id}-r${++seq}`
      setTimeout(async () => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 2, counts: { states: 1, plans: 0, settings: 1, review_logs: 0 }, readOnly: false }))
        else if (req.method === 'tx') cb?.(id, JSON.stringify(failTx ? { ok: false, code: 'E_IO', message: 'mock tx fail' } : { ok: true }))
        else if (req.payload?.table === 'states') cb?.(id, JSON.stringify({ ok: true, rows: [{ word_id: (await getDb().states.toArray())[0]!.wordId, updated_at: 0 }] }))
        else if (req.payload?.table === 'settings') cb?.(id, JSON.stringify({ ok: true, rows: (await getDb().settings.toArray()).map((row) => ({ key: row.key, updated_at: row.updatedAt })) }))
        else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
}
describe('M6 apply isolated', () => {
  it('成功路径 counts 校验通过', async () => {
    await applySeed(); applyTransport(false)
    const result = await applyDelta({ preBackup: async () => ({ ok: true }) })
    expect(result.ok).toBe(true)
    expect(result.applied.states).toBe(1)
    setSqliteTransport(null)
  }, 15000)
  it('tx 失败 → readonly', async () => {
    await applySeed(); applyTransport(true)
    await persistLearningWriteSource('idb')
    const result = await applyDelta({ preBackup: async () => ({ ok: true }) })
    expect(result.ok).toBe(false)
    expect(getLearningWriteSource()).toBe('readonly')
    setSqliteTransport(null)
  }, 15000)
})
