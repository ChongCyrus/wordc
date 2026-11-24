import './test-utils'
import { describe, expect, it } from 'vitest'
import { appendNewWordsToTodayPlan, createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
describe('rc8 appendNewWords idb KPI', () => {
  it('idb 模式追加后 plan cache 更新', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'idb-append', words: Array.from({ length: 3 }, (_, i) => ({ headword: `w${i}`, meanings: [{ cn: `义${i}` }] })) })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const words = await db.words.where('deckId').equals(deck.id).toArray()
    const result = await appendNewWordsToTodayPlan({ wordIds: words.map((word) => word.id), mode: 'manual' })
    expect(result.added).toBe(3)
    expect(result.plan.wordIds.length).toBe(3)
    expect((await db.plans.get(result.plan.id))?.wordIds.length).toBe(3)
  })
})
