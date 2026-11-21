/** 0.3.87/task-259：单元聚合/进度定位/排行/临时追加 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import { coreSenseStatKey } from '../../src/core'
import {
  appendWordsToTodayPlan,
  getChapterWordIds,
  getRankingWordIds,
  buildInitialState,
  createDeck,
  getDb,
  getDeckChapters,
  getDeckProgressLocation,
  getDeckWordIds,
  getTodayPlan,
  getWordFamiliarityRanking,
  getWordsByChapter,
  getWordsPage,
  resetDatabase,
  updateSettings,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'insights',
    words: Array.from({ length: 6 }, (_, index) => ({
      headword: `word${index}`,
      meanings: [{ cn: `含义${index}` }, { cn: `第二义${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const words = await getDb().words.where('deckId').equals(deck.id).toArray()
  words.sort((a, b) => a.order - b.order)
  const chapters = ['Unit1', 'Unit1', 'Unit2', 'Unit2', 'Unit3', 'Unit3']
  for (let i = 0; i < words.length; i += 1) await getDb().words.update(words[i]!.id, { chapter: chapters[i] })
  const now = Date.now()
  // word0: learned, familiarity 0; word2: learned, familiarity 1（更新）
  const state0 = buildInitialState(words[0]!, now)
  const state2 = buildInitialState(words[2]!, now)
  await getDb().states.bulkPut([
    {
      ...state0,
      phase: 'learning',
      firstSeenAt: now - 1000,
      lastReviewedAt: now - 2000,
      dueAt: now - 1,
      meaningStats: { [words[0]!.meanings[0]!.id]: { clicks: 0, encounters: 2 } },
      coreSenseStats: { [coreSenseStatKey(1, '本义')]: { clicks: 2, encounters: 2 } },
    },
    {
      ...state2,
      phase: 'learning',
      firstSeenAt: now - 1000,
      lastReviewedAt: now - 100,
      dueAt: now - 1,
      meaningStats: {
        [words[2]!.meanings[0]!.id]: { clicks: 2, encounters: 2 },
        [words[2]!.meanings[1]!.id]: { clicks: 2, encounters: 2 },
      },
      coreSenseStats: { [coreSenseStatKey(1, '本义')]: { clicks: 0, encounters: 2 } },
    },
  ])
  return { deck, words: (await getDb().words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order), now }
}

describe('0.3.87 · deck insights / temporary append', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('getDeckChapters：按词库顺序、计数/到期/平均熟悉度', async () => {
    const { deck } = await setup()
    const chapters = await getDeckChapters(deck.id)
    expect(chapters.map((chapter) => chapter.chapter)).toEqual(['Unit1', 'Unit2', 'Unit3'])
    expect(chapters[0]).toMatchObject({ total: 2, learned: 1, newCount: 1, dueCount: 1 })
    expect(chapters[1]).toMatchObject({ total: 2, learned: 1, newCount: 1, dueCount: 1 })
    expect(chapters[1]!.avgFamiliarity).toBe(1)
    expect(chapters[2]).toMatchObject({ total: 2, learned: 0, newCount: 2, dueCount: 0, avgFamiliarity: null })
  })

  it('getWordsByChapter：all/learned/new、搜索、分页', async () => {
    const { deck } = await setup()
    const all = await getWordsByChapter({ deckId: deck.id, chapter: 'Unit2', pageSize: 1, page: 1 })
    expect(all.total).toBe(2)
    expect(all.words).toHaveLength(1)
    expect(all.words[0]!.word.chapter).toBe('Unit2')
    expect(all.words[0]!.state).not.toBeNull()
    const learned = await getWordsByChapter({ deckId: deck.id, chapter: 'Unit2', filter: 'learned' })
    expect(learned.words.map((row) => row.word.headword)).toEqual(['word2'])
    const fresh = await getWordsByChapter({ deckId: deck.id, chapter: 'Unit2', filter: 'new' })
    expect(fresh.words.map((row) => row.word.headword)).toEqual(['word3'])
    const search = await getWordsByChapter({ deckId: deck.id, chapter: 'Unit1', query: '第二义0' })
    expect(search.words.map((row) => row.word.headword)).toEqual(['word0'])
    // 0.3.88 sort + 章节全选 IDs
    const alpha = await getWordsByChapter({ deckId: deck.id, chapter: 'Unit1', sort: 'alpha' })
    expect(alpha.words.map((row) => row.word.headword)).toEqual(['word0', 'word1'])
    const ids = await getChapterWordIds({ deckId: deck.id, chapter: 'Unit1', sort: 'alpha', max: 1 })
    expect(ids).toEqual([alpha.words[0]!.word.id])
    const desc = await getWordsByChapter({ deckId: deck.id, chapter: 'Unit1', sort: 'alpha', direction: 'desc' })
    expect(desc.words.map((row) => row.word.headword)).toEqual(['word1', 'word0'])
    const descIds = await getChapterWordIds({ deckId: deck.id, chapter: 'Unit1', sort: 'alpha', direction: 'desc', max: 1 })
    expect(descIds).toEqual([desc.words[0]!.word.id])
    expect((await getChapterWordIds({ deckId: deck.id, chapter: 'Unit2' })).length).toBe(2)
  })

  it('0.3.89：getDeckWordIds 跨分页 filter/sort/max；getWordsPage 支持 sort', async () => {
    const { deck, words } = await setup()
    expect(await getDeckWordIds({ deckId: deck.id })).toHaveLength(6)
    expect(await getDeckWordIds({ deckId: deck.id, filter: 'learned' })).toEqual([words[0]!.id, words[2]!.id])
    expect(await getDeckWordIds({ deckId: deck.id, filter: 'new', max: 2 })).toHaveLength(2)
    const alpha = await getDeckWordIds({ deckId: deck.id, sort: 'alpha' })
    expect(alpha).toHaveLength(6)
    const due = await getDeckWordIds({ deckId: deck.id, sort: 'due' })
    expect(due.slice(0, 2)).toEqual([words[0]!.id, words[2]!.id])
    expect(await getDeckWordIds({ deckId: deck.id, query: 'word2' })).toHaveLength(1)
    // pagination API sort
    const page = await getWordsPage(deck.id, { limit: 2, offset: 0, sort: 'alpha' })
    expect(page.words.map((word) => word.headword)).toEqual(['word0', 'word1'])
    const pageDesc = await getWordsPage(deck.id, { limit: 2, offset: 0, sort: 'alpha', direction: 'desc' })
    expect(pageDesc.words.map((word) => word.headword)).toEqual(['word5', 'word4'])
    expect((await getDeckWordIds({ deckId: deck.id, sort: 'alpha', direction: 'desc', max: 2 }))).toEqual(
      pageDesc.words.map((word) => word.id),
    )
    const studiedPage = await getWordsPage(deck.id, { filter: 'studied', sort: 'familiarity' })
    expect(studiedPage.words.map((word) => word.headword)).toEqual(['word0', 'word2'])
  })

  it('getDeckProgressLocation：最近学习词所在 Unit', async () => {
    const { deck } = await setup()
    const location = await getDeckProgressLocation(deck.id)
    expect(location).toEqual({
      lastLearnedChapter: 'Unit2',
      learnedInChapter: 1,
      chapterTotal: 2,
      overallLearned: 2,
      total: 6,
    })
  })

  it('0.3.94 熟悉度维度：含义级/本义级排序不同', async () => {
    const { deck, words } = await setup()
    const meaning = await getWordFamiliarityRanking({ deckId: deck.id, dimension: 'meaning', pageSize: 10 })
    const core = await getWordFamiliarityRanking({ deckId: deck.id, dimension: 'coreSense', pageSize: 10 })
    expect(meaning.items.map((item) => item.word.headword)).toEqual(['word0', 'word2'])
    expect(core.items.map((item) => item.word.headword)).toEqual(['word2', 'word0'])
    expect(meaning.items[0]!.meaningFamiliarity).toBe(0)
    expect(meaning.items[0]!.coreSenseFamiliarity).toBe(1)
    expect(core.items[0]!.coreSenseFamiliarity).toBe(0)
    expect(await getRankingWordIds({ deckId: deck.id, dimension: 'coreSense' })).toEqual([words[2]!.id, words[0]!.id])
    expect(await getDeckWordIds({ deckId: deck.id, sort: 'familiarity', dimension: 'coreSense' })).toEqual(
      [words[2]!.id, words[0]!.id].concat(words.filter((w) => ![words[0]!.id, words[2]!.id].includes(w.id)).map((w) => w.id)),
    )
  })

  it('getWordFamiliarityRanking：unfamiliar 升序/familiar 降序 + tie-break', async () => {
    const { deck, words, now } = await setup()
    // 增加一个同 familiarity 0 的词（word1）测试 tie-break（order 1 < word0 order? word0 order 0）
    const extra = buildInitialState(words[1]!, now)
    await getDb().states.put({
      ...extra,
      phase: 'learning',
      firstSeenAt: now,
      lastReviewedAt: now - 500,
      dueAt: now - 1,
      meaningStats: { [words[1]!.meanings[0]!.id]: { clicks: 0, encounters: 4 } },
    })
    const unfamiliar = await getWordFamiliarityRanking({ deckId: deck.id, order: 'unfamiliar', pageSize: 10 })
    expect(unfamiliar.items.map((item) => item.word.headword)).toEqual(['word0', 'word1', 'word2'])
    expect(unfamiliar.items[0]!.familiarity).toBe(0)
    expect(unfamiliar.items[2]!.familiarity).toBe(1)
    const familiar = await getWordFamiliarityRanking({ deckId: deck.id, order: 'familiar', pageSize: 10 })
    expect(familiar.items.map((item) => item.word.headword)).toEqual(['word2', 'word0', 'word1'])
    const search = await getWordFamiliarityRanking({ deckId: deck.id, query: 'word2' })
    expect(search.items.map((item) => item.word.headword)).toEqual(['word2'])
    // 0.3.88 sort + 排行全选 IDs
    const byOrder = await getWordFamiliarityRanking({ deckId: deck.id, sort: 'order', pageSize: 10 })
    expect(byOrder.items.map((item) => item.word.headword)).toEqual(['word0', 'word1', 'word2'])
    const rankedIds = await getRankingWordIds({ deckId: deck.id, order: 'familiar', max: 2 })
    expect(rankedIds).toHaveLength(2)
    expect(rankedIds[0]).toBe(words[2]!.id)
    // 0.3.91 direction：familiarity asc=least first；desc=most first
    expect((await getRankingWordIds({ deckId: deck.id, direction: 'asc' }))[0]).toBe(words[0]!.id)
    expect((await getRankingWordIds({ deckId: deck.id, direction: 'desc' }))[0]).toBe(words[2]!.id)
  })

  it('appendWordsToTodayPlan：任意状态词/去重/已完成计划可继续', async () => {
    const { deck, words, now } = await setup()
    const plan = await getTodayPlan({ deckId: deck.id, now })
    const first = await appendWordsToTodayPlan({ wordIds: [words[0]!.id, words[3]!.id], source: 'manual' }, now)
    // word0 已在复习计划中 → 去重后只追加 word3
    expect(first.added).toBe(1)
    expect(first.plan.wordIds).toContain(words[3]!.id)
    expect(first.plan.sources[words[3]!.id]).toBe('manual')
    const dup = await appendWordsToTodayPlan({ wordIds: [words[0]!.id, words[3]!.id] }, now)
    expect(dup.added).toBe(0)
    // 0.3.91 allowRepeat：已在计划的词可再追加一次
    const repeat = await appendWordsToTodayPlan({ wordIds: [words[3]!.id], allowRepeat: true }, now)
    expect(repeat.added).toBe(1)
    expect(repeat.plan.wordIds.filter((id) => id === words[3]!.id).length).toBe(2)
    // 已完成计划：追加后 completedAt=null
    const dbPlan = (await getDb().plans.get(plan.id))!
    await getDb().plans.put({ ...dbPlan, index: dbPlan.wordIds.length, completedAt: now })
    const reopened = await appendWordsToTodayPlan({ wordIds: [words[4]!.id] }, now)
    expect(reopened.added).toBe(1)
    expect(reopened.plan.completedAt).toBeNull()
  })
})
