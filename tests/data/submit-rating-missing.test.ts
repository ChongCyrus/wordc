/** 0.10.0：评分前词条缺失只补词/报错，绝不清其他 states */
import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildInitialState, createDeck, getDb, resetDatabase, submitRating, updateSettings } from '../../src/data'

describe('0.10.0 · submitRating missing word safety', () => {
  it('自定义词条缺失：只报错，不删其他 states', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'safe', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const words = await db.words.where('deckId').equals(deck.id).toArray()
    await db.states.put({ ...buildInitialState(words[0]!, Date.now()), phase: 'review' })
    await db.words.delete(words[1]!.id)
    await expect(submitRating(words[1]!.id, 'familiar')).rejects.toThrow(/词条不存在/)
    expect(await db.states.count()).toBe(1)
    expect(await db.states.get(words[0]!.id)).toBeTruthy()
    expect(await db.words.where('deckId').equals(deck.id).count()).toBe(1)
  })
})
