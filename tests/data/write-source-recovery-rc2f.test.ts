import './test-utils'
import { primeIdbCacheReady } from './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInitialState, createDeck, getDb, getLearningWriteSource, persistLearningWriteSource, repairLearningWriteSource, resetDatabase, setSqliteTransport, updateSettings } from '../../src/data'

afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb') })

describe('rc2f readonly recovery', () => {
  it('SQLite v3/integrity 可读时 readonly→sqlite <5s', async () => {
    await resetDatabase(); await primeIdbCacheReady()
    const deck = await createDeck({ name: 'rc2f', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    const state = { ...buildInitialState(word, 1), phase: 'review' as const }
    await db.states.put(state)
    const stateRow = { word_id: state.wordId, deck_id: state.deckId, phase: state.phase, stability: state.stability, difficulty: state.difficulty, reps: state.reps, lapses: state.lapses, first_seen_at: null, last_reviewed_at: null, due_at: null, next_interval_days: 1, retrievability: 0, last_rating: null, same_day_count: 0, same_day_date: '', today_progress: null, today_progress_level: null, can_finish_today: null, meaning_stats_json: '{}', core_sense_stats_json: null, part_stats_json: null, same_day_requeued: 0, imported_from: null, imported_at: null, created_at: 1, updated_at: 1 }
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 3, readOnly: false, counts: { states: 1, plans: 0, settings: 1, review_logs: 0 } }))
        else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true }))
        else if (req.method === 'query') cb?.(id, JSON.stringify({ ok: true, rows: req.payload?.table === 'states' ? [stateRow] : req.payload?.table === 'settings' ? [{ key: 'data.selectedDeckId', value_json: JSON.stringify(deck.id), updated_at: Date.now() + 100000 }] : [] }))
        else cb?.(id, JSON.stringify({ ok: true }))
      }, 0)
      return JSON.stringify({ requestId: id })
    } } as never)
    await persistLearningWriteSource('readonly')
    const started = Date.now()
    const result = await repairLearningWriteSource()
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(getLearningWriteSource()).toBe('sqlite')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
