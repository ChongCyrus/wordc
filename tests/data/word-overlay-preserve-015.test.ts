import './test-utils'
import { describe, expect, it } from 'vitest'
import { addWords, createDeck, getDb, resetDatabase, updateWord, upsertWord } from '../../src/data'

describe('0.15 词条重建保留 overlay', () => {
  async function setup() {
    await resetDatabase()
    const deck = await createDeck({ name: 'overlay', words: [{ headword: 'keep', meanings: [{ cn: '义' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().words.put({
      ...word,
      rootEtymology: { parts: [{ type: 'root', text: 'keep', meaning: '保持' }] },
      userNotes: [{ text: '我的笔记' }],
      userMnemonics: [{ text: '我的助记' }],
      derivationMap: { nodes: [{ id: 'n1', label: '引申' }] },
    } as never)
    return { deck, wordId: word.id }
  }

  it('updateWord 不丢 overlay', async () => {
    const { wordId } = await setup()
    await updateWord(wordId, { meanings: [{ cn: '新义' }] })
    const word = (await getDb().words.get(wordId))!
    expect(word.rootEtymology).toBeTruthy()
    expect(word.userNotes?.[0]?.text).toBe('我的笔记')
    expect(word.userMnemonics?.[0]?.text).toBe('我的助记')
    expect(word.derivationMap).toBeTruthy()
  })

  it('upsertWord 不丢 overlay', async () => {
    const { deck, wordId } = await setup()
    await upsertWord(deck.id, { headword: 'keep', meanings: [{ cn: '合并义' }] })
    const word = (await getDb().words.get(wordId))!
    expect(word.rootEtymology).toBeTruthy()
    expect(word.userNotes?.[0]?.text).toBe('我的笔记')
  })

  it('addWords 命中已存在词不丢 overlay', async () => {
    const { deck, wordId } = await setup()
    await addWords(deck.id, [{ headword: 'keep', meanings: [{ cn: '批量义' }] }])
    const word = (await getDb().words.get(wordId))!
    expect(word.userNotes?.[0]?.text).toBe('我的笔记')
    expect(word.derivationMap).toBeTruthy()
  })
})
