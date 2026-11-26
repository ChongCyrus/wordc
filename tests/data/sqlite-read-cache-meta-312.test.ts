import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInitialState, createDeck, getDb, readStateThroughCache, resetDatabase, setSqliteTransport } from '../../src/data'
afterEach(() => setSqliteTransport(null))
describe('task-312 C-04 cache meta fail-closed', () => {
  it('meta 缺失 → 回源 SQLite，不信任 IDB', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'c04', words: [{ headword: 'c4', meanings: [{ cn: '义' }] }] })
    const db = getDb(); const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    const idbState = buildInitialState(word, 1)
    await db.states.put({ ...idbState, reps: 2 })
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'query') cb?.(id, JSON.stringify({ ok: true, rows: [{ word_id: word.id, deck_id: deck.id, phase: 'review', stability: 5, difficulty: 5, due_at: 1, reps: 9, lapses: 0, today_progress: 0, next_interval_days: 1, last_rating: null, last_reviewed_at: null, updated_at: 9, meaning_stats_json: '{}', core_sense_stats_json: '{}', part_stats_json: '{}' }] })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } })
    const state = await readStateThroughCache(word.id)
    expect(state?.reps).toBe(9)
  })
})
