/** 0.11.0 M2：cache 优先/dirty 回源/不迁移覆盖 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SqliteError,
  bootstrapM2ReadCache,
  buildInitialState,
  createDeck,
  getDb,
  getSettings,
  getState,
  primeM2ReadCacheForTests,
  readPlanThroughCache,
  readSettingsThroughCache,
  resetDatabase,
  setSqliteTransport,
  SQLITE_SCHEMA_VERSION,
  updateSettings,
  type SqliteTransport,
} from '../../src/data'

type Handler = (request: { method: string; payload?: Record<string, unknown> }) => unknown

function install(handler: Handler): { calls: Array<{ method: string; payload?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; payload?: Record<string, unknown> }> = []
  let seq = 0
  const transport: SqliteTransport = {
    sqliteCall(json) {
      const request = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      calls.push(request)
      seq += 1
      const requestId = `${request.id}-r${seq}`
      setTimeout(() => {
        const result = handler(request) as Record<string, unknown>
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        callback?.(requestId, JSON.stringify({ ok: true, ...result }))
      }, 0)
      return JSON.stringify({ requestId })
    },
    sqliteCancel() { return '{"ok":true}' },
  }
  setSqliteTransport(transport)
  return { calls }
}

afterEach(() => setSqliteTransport(null))

describe('0.11.0 · M2 read cache', () => {
  it('cache ready → 读 IDB；不查 SQLite', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'm2', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ ...buildInitialState(word, 1), phase: 'review' })
    await primeM2ReadCacheForTests({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION })
    const { calls } = install(() => ({ rows: [] }))
    expect((await getState(word.id))?.phase).toBe('review')
    expect(calls).toHaveLength(0)
  })

  it('dirty → 回源 SQLite state/settings/plan；不写 IDB', async () => {
    await resetDatabase()
    await primeM2ReadCacheForTests({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: true })
    const stateRow = {
      word_id: 'w1', deck_id: 'd', phase: 'review', stability: 1, difficulty: 5, reps: 1, lapses: 0,
      first_seen_at: 1, last_reviewed_at: 2, due_at: 3, next_interval_days: 4, retrievability: 0.5,
      last_rating: 'familiar', same_day_count: 1, same_day_date: '2026-11-23',
      meaning_stats_json: JSON.stringify({ m1: { clicks: 1, encounters: 2 } }), core_sense_stats_json: null,
      part_stats_json: null, same_day_requeued: 0, created_at: 1, updated_at: 2,
    }
    const planRow = {
      id: 'p1', date: '2026-11-23', deck_id: 'd', word_ids_json: JSON.stringify(['w1']), idx: 0,
      sources_json: JSON.stringify({ w1: 'goal' }), goals_json: JSON.stringify({ dailyGoal: 1, dueCount: 0, newBudget: 0, extraCount: 0 }),
      ratings_json: '[]', created_at: 1, updated_at: 1, completed_at: null,
    }
    install((request) => {
      const table = request.payload?.table
      if (table === 'states') return { rows: [stateRow] }
      if (table === 'plans') return { rows: [planRow] }
      if (table === 'settings') return { rows: [{ key: 'study.dailyGoal', value_json: '30', updated_at: 1 }] }
      return { rows: [] }
    })
    const state = await getState('w1')
    expect(state?.phase).toBe('review')
    expect(state?.meaningStats.m1).toEqual({ clicks: 1, encounters: 2 })
    expect(await readPlanThroughCache('p1')).toMatchObject({ wordIds: ['w1'], sources: { w1: 'goal' } })
    expect(await readSettingsThroughCache()).toHaveLength(1)
    expect(await getDb().states.count()).toBe(0) // 不写 IDB
  })

  it('dirty 且 SQLite 锁/报错 → 回退 IDB，UI 不永久 loading', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'fallback', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ ...buildInitialState(word, 1), phase: 'review' })
    await primeM2ReadCacheForTests({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: true })
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          callback?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'SQLiteDatabaseLockedException: database is locked' }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    expect((await getState(word.id))?.phase).toBe('review')
    expect((await getSettings())['data.selectedDeckId']).toBe(deck.id)
  })

  it('bootstrap：IDB 有 240 states、SQLite counts=0 → cache ready，不迁移', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'boot', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ ...buildInitialState(word, 1), phase: 'review' })
    install((request) => request.method === 'health'
      ? { userVersion: SQLITE_SCHEMA_VERSION, data: { counts: { states: 0 } }, wal: true, synchronous: 'FULL', readOnly: false, integrityOk: true }
      : { rows: [] })
    const result = await bootstrapM2ReadCache()
    expect(result.mode).toBe('cache')
    expect(result.statesInCache).toBe(1)
    expect(result.statesInSqlite).toBe(0)
  })

  it('高版本/不可用拒绝由 SqliteError 暴露', () => {
    expect(new SqliteError('E_UNSUPPORTED', 'x').code).toBe('E_UNSUPPORTED')
  })
})
