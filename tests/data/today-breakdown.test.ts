import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDeck,
  exportMigration,
  getDb,
  getHomeStudyData,
  getTodayBreakdown,
  getTodayPlan,
  rateInPlan,
  resetDatabase,
  submitRating,
  updateSettings,
} from '../../src/data'
import type { DailyPlan } from '../../src/data'

const NOW = new Date(2026, 11, 2, 10, 0, 0).getTime()
const DAY = 86_400_000

async function setupDeck(wordCount = 30) {
  const deck = await createDeck({
    name: '今日拆分词库',
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `tb${index}`,
      meanings: [{ pos: 'n.', cn: `词${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

/** 造 3 个「昨天忘记 → 今天到期」的复习词 */
async function seedReviewWords(deckId: string, count = 3) {
  const db = getDb()
  const words = await db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .limit(count)
    .toArray()
  for (const word of words) {
    await submitRating(word.id, 'forgot', NOW - DAY + 1000)
  }
  return words.map((word) => word.id)
}

beforeEach(async () => {
  await resetDatabase()
})

describe('task-49：今日已学拆分 getTodayBreakdown', () => {
  it('3 复习 + 5 新学，评 2 复习 + 1 新学 → planned/learned/remaining 与 items 正确', async () => {
    const deck = await setupDeck(30)
    await seedReviewWords(deck.id, 3)
    await updateSettings({ 'study.dailyGoal': 8 })
    const plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(8)

    let breakdown = await getTodayBreakdown(NOW)
    expect(breakdown.planId).toBe(plan.id)
    expect(breakdown.review).toEqual({ planned: 3, learned: 0, remaining: 3 })
    expect(breakdown.new).toEqual({ planned: 5, learned: 0, remaining: 5 })
    expect(breakdown.totalPlanned).toBe(8)
    expect(breakdown.totalLearned).toBe(0)
    expect(breakdown.items).toHaveLength(8)
    expect(breakdown.items.filter((item) => item.category === 'review')).toHaveLength(3)
    expect(breakdown.items.filter((item) => item.category === 'new')).toHaveLength(5)
    // review 组在前
    expect(breakdown.items[0]!.category).toBe('review')
    expect(breakdown.items[3]!.category).toBe('new')
    expect(breakdown.items.every((item) => item.headword.length > 0)).toBe(true)

    const reviewIds = breakdown.items.filter((item) => item.category === 'review').map((item) => item.wordId)
    const newId = breakdown.items.find((item) => item.category === 'new')!.wordId
    await rateInPlan({ wordId: reviewIds[0]!, rating: 'familiar', now: NOW + 1000 })
    await rateInPlan({ wordId: reviewIds[1]!, rating: 'vague', now: NOW + 2000 })
    await rateInPlan({ wordId: newId, rating: 'familiar', now: NOW + 3000 })

    breakdown = await getTodayBreakdown(NOW + 4000)
    expect(breakdown.review).toEqual({ planned: 3, learned: 2, remaining: 1 })
    expect(breakdown.new).toEqual({ planned: 5, learned: 1, remaining: 4 })
    expect(breakdown.totalLearned).toBe(3)
    const learnedItems = breakdown.items.filter((item) => item.learned)
    expect(learnedItems).toHaveLength(3)
    expect(learnedItems.find((item) => item.wordId === reviewIds[1]!)?.rating).toBe('vague')
    expect(learnedItems.find((item) => item.wordId === newId)?.category).toBe('new')
  }, 60_000)

  it('回炉词只算一次：planned 不变、requeued=true、计入 learned', async () => {
    const deck = await setupDeck(20)
    await seedReviewWords(deck.id, 1)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const newId = (await getTodayBreakdown(NOW)).items.find((item) => item.category === 'new')!.wordId

    await rateInPlan({ wordId: newId, rating: 'vague', now: NOW + 1000 })
    const withRequeue = (await getDb().plans.get(plan.id))!
    expect(withRequeue.wordIds.filter((wordId) => wordId === newId)).toHaveLength(2) // 回炉重复

    const breakdown = await getTodayBreakdown(NOW + 2000)
    // 1 个复习占掉预算 → 新学 budget=4（goal 5）
    expect(breakdown.new.planned).toBe(4) // 去重后仍 4（不因回炉变 5）
    expect(breakdown.items).toHaveLength(5) // 1 review + 4 new
    expect(breakdown.new.learned).toBe(1)
    const requeuedItem = breakdown.items.find((item) => item.wordId === newId)!
    expect(requeuedItem.requeued).toBe(true)
    expect(requeuedItem.rating).toBe('vague')
    expect(breakdown.items.filter((item) => item.requeued)).toHaveLength(1)
  }, 60_000)

  it('加学词 isExtra=true，计入 new，且不重复', async () => {
    const deck = await setupDeck(20)
    await updateSettings({ 'study.dailyGoal': 5 })
    const db = getDb()
    const far = (
      await db.words
        .where('[deckId+order]')
        .between([deck.id, -Infinity], [deck.id, Infinity])
        .offset(18)
        .limit(1)
        .toArray()
    )[0]!
    const plan = await getTodayPlan({ now: NOW, extraNewWordIds: [far.id] })
    expect(plan.wordIds).toHaveLength(6) // 5 新学 + 1 加学
    expect(plan.sources[far.id]).toBe('extra')

    const breakdown = await getTodayBreakdown(NOW)
    expect(breakdown.new.planned).toBe(6)
    expect(breakdown.totalPlanned).toBe(6)
    const item = breakdown.items.find((entry) => entry.wordId === far.id)!
    expect(item.isExtra).toBe(true)
    expect(item.category).toBe('new')
    expect(breakdown.items.filter((entry) => entry.isExtra)).toHaveLength(1)
  }, 60_000)

  it('无 plan / 跨天 → 全 0 + 空 items；HomeStudyData.breakdown 与接口一致', async () => {
    const deck = await setupDeck(20)
    // 无 plan
    let breakdown = await getTodayBreakdown(NOW)
    expect(breakdown).toEqual({
      deckId: deck.id,
      date: '2026-12-02',
      planId: null,
      review: { planned: 0, learned: 0, remaining: 0 },
      new: { planned: 0, learned: 0, remaining: 0 },
      totalPlanned: 0,
      totalLearned: 0,
      items: [],
    })

    await updateSettings({ 'study.dailyGoal': 6 })
    const plan = await getTodayPlan({ now: NOW })
    await rateInPlan({ wordId: plan.wordIds[0]!, rating: 'familiar', now: NOW + 1000 })
    breakdown = await getTodayBreakdown(NOW + 2000)
    expect(breakdown.totalLearned).toBe(1)
    const home = await getHomeStudyData(NOW + 2000)
    expect(home.breakdown).toEqual(breakdown) // HomeStudyData 内嵌同一份拆分

    // 跨天：新一天没有 plan → 全 0
    const nextDay = await getTodayBreakdown(NOW + DAY)
    expect(nextDay.planId).toBeNull()
    expect(nextDay.totalPlanned).toBe(0)
    expect(nextDay.items).toEqual([])
  }, 60_000)

  it('旧 plan（手动写入、无新字段）也能算；派生数据不进迁移包', async () => {
    const deck = await setupDeck(20)
    await updateSettings({ 'study.dailyGoal': 5 })
    const db = getDb()
    const words = await db.words
      .where('[deckId+order]')
      .between([deck.id, -Infinity], [deck.id, Infinity])
      .limit(4)
      .toArray()
    const oldPlan: DailyPlan = {
      id: `${'2026-12-02'}:${deck.id}`,
      date: '2026-12-02',
      deckId: deck.id,
      wordIds: words.map((word) => word.id),
      index: 1,
      sources: Object.fromEntries(words.map((word) => [word.id, 'goal' as const])),
      goals: { dailyGoal: 4, dueCount: 0, newBudget: 4, extraCount: 0 },
      ratings: [
        { wordId: words[0]!.id, rating: 'familiar', reviewedAt: NOW + 1000, longTermUpdate: true },
      ],
      createdAt: NOW,
      updatedAt: NOW + 1000,
      completedAt: null,
    }
    await db.plans.put(oldPlan)
    const breakdown = await getTodayBreakdown(NOW + 2000)
    expect(breakdown.totalPlanned).toBe(4)
    expect(breakdown.totalLearned).toBe(1)
    expect(breakdown.new.learned).toBe(1)

    // 迁移包只含 decks/words/states/reviewLogs/settings/plans，不含派生 breakdown
    const text = await (await exportMigration()).text()
    expect(text).not.toContain('"breakdown"')
  }, 120_000)
})
