/** 0.3.89/task-264：词详情 bundle / 语义 session 数据一次性读取 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildInitialState,
  createDeck,
  getDb,
  getWordDetailBundle,
  getWordSemanticSessionData,
  resetDatabase,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'detail',
    words: [{ headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }, { cn: '阿尔法' }] }],
  })
  const db = getDb()
  const base = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
  const now = Date.now()
  await db.words.put({
    ...base,
    derivationMap: { rootLabel: '根', text: '生成元→含义', source: 'manual', updatedAt: now },
    coreSenseOverview: { text: '串联记忆', source: 'ai', updatedAt: now },
    senseMnemonics: [{ coreSenseIndex: 1, label: '本义', text: '助记', source: 'manual', updatedAt: now }],
    userNotes: [{ id: 'n1', text: '我的笔记' }],
    userMnemonics: [{ id: 'm1', type: '联想', text: '我的助记' }],
  })
  await db.packItems.put({
    id: 'detail-pack:1',
    packId: 'detail-pack',
    seq: 1,
    wordId: base.id,
    headword: base.headword,
    headwordLower: base.headwordLower,
    payload: { headword: base.headword, coreSenses: [{ index: 1, label: '本义', note: '说明' }] },
    status: 'applied',
    contentHashes: [],
    createdAt: now,
    appliedAt: now,
  })
  const state = buildInitialState(base, now)
  await db.states.put({
    ...state,
    phase: 'learning',
    meaningStats: { [base.meanings[0]!.id]: { clicks: 1, encounters: 2 } },
    coreSenseStats: { [JSON.stringify(['本义', 1])]: { clicks: 2, encounters: 3 } },
  })
  return { deck, word: (await db.words.get(base.id))! }
}

describe('0.3.89 · word detail bundle', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('getWordDetailBundle：word/state/effective/全部用户内容/统计', async () => {
    const { word } = await setup()
    const bundle = (await getWordDetailBundle(word.id))!
    expect(bundle.word.id).toBe(word.id)
    expect(bundle.state?.phase).toBe('learning')
    expect(bundle.effectiveContent?.coreSenses.map((sense) => sense.label)).toEqual(['本义'])
    expect(bundle.derivationMap?.rootLabel).toBe('根')
    expect(bundle.coreSenseOverview?.text).toBe('串联记忆')
    expect(bundle.senseMnemonics[0]?.text).toBe('助记')
    expect(bundle.userNotes[0]?.text).toBe('我的笔记')
    expect(bundle.userMnemonics[0]?.text).toBe('我的助记')
    expect(bundle.coreSenseStats[JSON.stringify(['本义', 1])]).toEqual({ clicks: 2, encounters: 3 })
    expect(await getWordDetailBundle('missing')).toBeNull()
  })

  it('getWordSemanticSessionData：sessionWord/meaningStats/coreSenses/stats', async () => {
    const { word } = await setup()
    const data = (await getWordSemanticSessionData(word.id))!
    expect(data.sessionWord.wordId).toBe(word.id)
    expect(data.sessionWord.meanings.map((meaning) => meaning.meaningId)).toEqual(word.meanings.map((meaning) => meaning.id))
    expect(data.sessionWord.meanings[0]).toMatchObject({ pos: 'n.', cn: '甲' })
    expect(data.meaningStats[word.meanings[0]!.id]).toEqual({ clicks: 1, encounters: 2 })
    expect(data.coreSenseStats[JSON.stringify(['本义', 1])]).toEqual({ clicks: 2, encounters: 3 })
    expect(data.coreSenses.map((sense) => sense.label)).toEqual(['本义'])
    expect(await getWordSemanticSessionData('missing')).toBeNull()
  })

  it('操作后重读一致（浏览器刷新等价：直接重新读库）', async () => {
    const { word } = await setup()
    const db = getDb()
    await db.words.update(word.id, { userNotes: [{ id: 'n2', text: '更新笔记' }] })
    await db.states.update(word.id, {
      coreSenseStats: { [JSON.stringify(['本义', 1])]: { clicks: 5, encounters: 5 } },
    })
    const bundle = (await getWordDetailBundle(word.id))!
    expect(bundle.userNotes[0]?.text).toBe('更新笔记')
    expect(bundle.coreSenseStats[JSON.stringify(['本义', 1])]).toEqual({ clicks: 5, encounters: 5 })
    const semantic = (await getWordSemanticSessionData(word.id))!
    expect(semantic.coreSenseStats[JSON.stringify(['本义', 1])]).toEqual({ clicks: 5, encounters: 5 })
  })
})
