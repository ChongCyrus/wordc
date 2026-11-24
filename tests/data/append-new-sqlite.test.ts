import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { appendNewWordsToTodayPlan, createDeck, getDb, localDateKey, persistLearningWriteSource, planIdOf, resetDatabase, setSqliteTransport, updateSettings } from '../../src/data'
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb') })
describe('rc6 appendNewWords sqlite', () => {
  it('成功追加、IDB cache 增加、dispatch plan-updated', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'append-new', words: Array.from({ length: 4 }, (_, i) => ({ headword: `w${i}`, meanings: [{ cn: `义${i}` }] })) })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const words = await db.words.where('deckId').equals(deck.id).toArray()
    const planId = planIdOf(localDateKey(Date.now()), deck.id)
    await db.plans.put({ id: planId, date: localDateKey(Date.now()), deckId: deck.id, wordIds: [], index: 0, sources: {}, goals: { dailyGoal: 10, dueCount: 0, newBudget: 0, extraCount: 0 }, ratings: [], createdAt: 1, updatedAt: 1, completedAt: null } as never)
    await persistLearningWriteSource('sqlite')
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'tx') cb?.(id, JSON.stringify({ ok: true })); else if (req.payload?.table === 'plans') cb?.(id, JSON.stringify({ ok: true, rows: [{ id: planId, date: localDateKey(Date.now()), deck_id: deck.id, word_ids_json: '[]', idx: 0, sources_json: '{}', goals_json: '{}', ratings_json: '[]', created_at: 1, updated_at: 1, completed_at: null }] })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await appendNewWordsToTodayPlan({ wordIds: words.map((word) => word.id), mode: 'manual' })
    expect(result.added).toBe(4)
    expect(result.plan.wordIds.length).toBe(4)
    expect((await db.plans.get(planId))?.wordIds.length).toBe(4)
  })
})
