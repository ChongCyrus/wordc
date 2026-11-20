/** 0.3.87/task-258：新词来源 manual/auto + 候选/随机/顺序/追加/移除 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendNewWordsToTodayPlan,
  buildInitialState,
  createDeck,
  getDb,
  getManualNewWordCandidates,
  getTodayPlan,
  getWord,
  pickUnlearnedNewWords,
  removeUnlearnedAutoNewWords,
  resetDatabase,
  updateSettings,
} from '../../src/data'

async function setupDeck(count = 10) {
  const deck = await createDeck({
    name: 'manual-new',
    words: Array.from({ length: count }, (_, index) => ({
      headword: `word${String(index).padStart(2, '0')}`,
      meanings: [{ pos: 'n.', cn: `含义${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const words = await getDb().words.where('deckId').equals(deck.id).toArray()
  words.sort((a, b) => a.order - b.order)
  return { deck, words }
}

async function markLearned(wordId: string, _deckId: string, now: number, dueAgo = 1000) {
  const word = (await getWord(wordId))!
  const state = buildInitialState(word, now)
  await getDb().states.put({
    ...state,
    phase: 'learning',
    firstSeenAt: now - 86_400_000,
    lastReviewedAt: now - 3_600_000,
    dueAt: now - dueAgo,
    lastRating: 'familiar',
  })
}

describe('0.3.87 · manual new words', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('manual 默认：今日计划只放复习（新词预算0），auto 恢复旧行为', async () => {
    const { deck, words } = await setupDeck(5)
    const now = Date.now()
    await markLearned(words[0]!.id, deck.id, now)
    const manual = await getTodayPlan({ deckId: deck.id, now })
    expect(manual.wordIds).toEqual([words[0]!.id])
    expect(manual.goals.newBudget).toBe(0)

    await updateSettings({ 'study.newWordSource': 'auto' })
    const auto = await getTodayPlan({ deckId: deck.id, now, forceRebuild: true })
    expect(auto.wordIds.length).toBeGreaterThan(1)
    expect(auto.wordIds[0]).toBe(words[0]!.id)
    expect(auto.goals.newBudget).toBeGreaterThan(0)
  })

  it('候选/顺序/随机/追加去重/候选不足/已完成追加可继续', async () => {
    const { deck } = await setupDeck(8)
    const now = Date.now()
    const plan = await getTodayPlan({ deckId: deck.id, now })
    expect(plan.wordIds).toEqual([])
    expect(plan.completedAt).not.toBeNull()

    const candidates = await getManualNewWordCandidates({ limit: 5 }, now)
    expect(candidates.total).toBe(8)
    expect(candidates.words).toHaveLength(5)
    // 中文筛选
    expect((await getManualNewWordCandidates({ query: '含义3' }, now)).words.map((word) => word.headword)).toEqual(['word03'])
    // 单元筛选：无 chapter 数据 -> 空
    expect((await getManualNewWordCandidates({ chapter: 'unit-1' }, now)).total).toBe(0)

    const order = await pickUnlearnedNewWords({ deckId: deck.id, mode: 'order', count: 3 })
    expect(order.map((word) => word.order)).toEqual([1, 2, 3])
    const randomA = await pickUnlearnedNewWords({ deckId: deck.id, mode: 'random', count: 4, seed: 7 })
    const randomB = await pickUnlearnedNewWords({ deckId: deck.id, mode: 'random', count: 4, seed: 7 })
    expect(randomA.map((word) => word.id)).toEqual(randomB.map((word) => word.id))
    expect(new Set(randomA.map((word) => word.id)).size).toBe(4)

    const appended = await appendNewWordsToTodayPlan({ mode: 'order', count: 3 }, now)
    expect(appended.added).toBe(3)
    expect(appended.plan.wordIds).toEqual(order.map((word) => word.id))
    expect(appended.plan.sources[order[0]!.id]).toBe('order')
    expect(appended.plan.completedAt).toBeNull()
    // 重复追加去重
    const duplicate = await appendNewWordsToTodayPlan({ wordIds: order.map((word) => word.id), mode: 'manual' }, now)
    expect(duplicate.added).toBe(0)
    // 候选不足：只剩 5 个未入计划
    const second = await appendNewWordsToTodayPlan({ mode: 'random', count: 999, seed: 1 }, now)
    expect(second.added).toBe(5)
    expect(second.plan.wordIds.length).toBe(8)
    // 完成态追加后可继续
    await getDb().plans.update(appended.plan.id, { index: 8, completedAt: now })
    const reopened = await appendNewWordsToTodayPlan({ wordIds: [], mode: 'manual' }, now)
    expect(reopened.added).toBe(0) // 无候选
    const dbPlan = await getDb().plans.get(appended.plan.id)
    expect(dbPlan?.wordIds.length).toBe(8)
  }, 20_000)

  it('移除未学自动新词：保留复习/已学/手动词，调整 index', async () => {
    const { deck, words } = await setupDeck(6)
    const now = Date.now()
    await markLearned(words[0]!.id, deck.id, now)
    await updateSettings({ 'study.newWordSource': 'auto' })
    const plan = await getTodayPlan({ deckId: deck.id, now, forceRebuild: true })
    expect(plan.wordIds.length).toBeGreaterThan(2)
    // 学掉最后一个自动新词（rated -> 保留）
    const newIds = plan.wordIds.filter((id) => plan.sources[id] === 'goal' && id !== words[0]!.id)
    const learnedNew = newIds[0]!
    await markLearned(learnedNew, deck.id, now, -1000)
    // 手动来源标记（保留）：把 word01 改成 manual
    const dbPlan = (await getDb().plans.get(plan.id))!
    dbPlan.sources[words[1]!.id] = 'manual'
    await getDb().plans.put(dbPlan)
    const removed = await removeUnlearnedAutoNewWords(now)
    expect(removed.removed).toBe(newIds.length - 2)
    expect(removed.plan.wordIds).toContain(words[0]!.id) // 复习
    expect(removed.plan.wordIds).toContain(learnedNew) // 已学新词
    expect(removed.plan.wordIds).toContain(words[1]!.id) // 手动
    expect(removed.plan.sources[words[1]!.id]).toBe('manual')
    expect(removed.plan.wordIds.length).toBe(3)
    expect(removed.plan.index).toBe(dbPlan.index)
  })
})
