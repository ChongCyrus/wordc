/** 0.10.0：清空/删库前强制预备份，否则拒绝；备份成功才执行 */
import './test-utils'
import { describe, expect, it } from 'vitest'
import {
  buildInitialState,
  clearAllData,
  createDeck,
  deleteDeck,
  getDb,
  exportDeck,
  importDeckFile,
  resetDatabase,
  updateSettings,
} from '../../src/data'

async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'safe', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
  await getDb().states.put({ ...buildInitialState(word, Date.now()), phase: 'review' })
  return { deck, word }
}

describe('0.10.0 · clear/delete safety', () => {
  it('clearAllData 无 preBackup 拒绝，数据保持；有备份才清空', async () => {
    const { deck } = await seed()
    await expect(clearAllData()).rejects.toThrow(/备份/)
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
    expect(await getDb().states.count()).toBe(1)
    let backedUp = 0
    await clearAllData({
      preBackup: async () => {
        backedUp += 1
        return { ok: true }
      },
    })
    expect(backedUp).toBe(1)
    expect(await getDb().words.count()).toBe(0)
    expect(await getDb().states.count()).toBe(0)
  })

  it('importDeckFile replace 有数据必须 preBackup；无/失败拒绝、成功才替换', async () => {
    const { deck } = await seed()
    const text = await (await exportDeck(deck.id)).text()
    await expect(importDeckFile(text, { strategy: 'replace' })).rejects.toThrow(/备份/)
    expect(await getDb().states.count()).toBe(1)
    await expect(importDeckFile(text, { strategy: 'replace', preBackup: async () => ({ ok: false, error: 'mock' }) })).rejects.toThrow(/预备份失败/)
    expect(await getDb().states.count()).toBe(1)
    let backedUp = 0
    const report = await importDeckFile(text, {
      strategy: 'replace',
      preBackup: async () => {
        backedUp += 1
        return { ok: true }
      },
    })
    expect(report.ok).toBe(true)
    expect(backedUp).toBe(1)
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
    expect(await getDb().states.count()).toBe(0)
  })

  it('clearAllData 备份失败拒绝；deleteDeck 有 states 无备份拒绝', async () => {
    const { deck } = await seed()
    await expect(clearAllData({ preBackup: async () => ({ ok: false, error: 'mock' }) })).rejects.toThrow(/预备份失败/)
    expect(await getDb().words.count()).toBe(1)
    await expect(deleteDeck(deck.id)).rejects.toThrow(/备份/)
    expect(await getDb().decks.get(deck.id)).toBeTruthy()
    let backedUp = 0
    await deleteDeck(deck.id, {
      preBackup: async () => {
        backedUp += 1
        return { ok: true }
      },
    })
    expect(backedUp).toBe(1)
    expect(await getDb().decks.get(deck.id)).toBeUndefined()
    expect(await getDb().states.count()).toBe(0)
  })
})
