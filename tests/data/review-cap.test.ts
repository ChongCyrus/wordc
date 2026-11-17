import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDeck,
  getDb,
  getHomeStudyData,
  getSettings,
  getTodayBreakdown,
  getTodayPlan,
  normalizeDailyReviewCap,
  normalizeSettingValue,
  resetDatabase,
  settingOrDefault,
  updateSettings,
} from '../../src/data'
import { createWordState, startOfLocalDay } from '../../src/core'

const NOW = new Date(2026, 11, 3, 10, 0, 0).getTime()
const DAY = 86_400_000

async function setupDeck(wordCount = 500) {
  const deck = await createDeck({
    name: '复习上限词库',
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `rc${index}`,
      meanings: [{ pos: 'n.', cn: `词${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

/** 直接把前 count 个词写成「昨天到期」的 review states（快，不走 submitRating） */
async function seedDueStates(deckId: string, count: number): Promise<string[]> {
  const db = getDb()
  const words = await db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .limit(count)
    .toArray()
  const states = words.map((word) => {
    const state = createWordState({ wordId: word.id, deckId, now: NOW - DAY })
    state.phase = 'review'
    state.firstSeenAt = NOW - DAY
    state.lastReviewedAt = NOW - DAY
    state.dueAt = startOfLocalDay(NOW) - 1
    state.stability = 5
    state.nextIntervalDays = 1
    return state
  })
  await db.states.bulkPut(states)
  return words.map((word) => word.id)
}

beforeEach(async () => {
  await resetDatabase()
})

describe('task-51：每日复习上限 study.dailyReviewCap', () => {
  it('实景：due=459, cap=50, goal=30 → 复习 50 / 新学 0 / backlog 409', async () => {
    const deck = await setupDeck(500)
    await seedDueStates(deck.id, 459)
    await updateSettings({ 'study.dailyGoal': 30, 'study.dailyReviewCap': 50 })

    const plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(50) // 复习 50、新学 0

    const breakdown = await getTodayBreakdown(NOW)
    expect(breakdown.review.planned).toBe(50) // 今日入队复习数
    expect(breakdown.new.planned).toBe(0)

    const home = await getHomeStudyData(NOW)
    expect(home.dueCount).toBe(459) // 全部到期（含顺延）
    expect(home.plannedReview).toBe(50)
    expect(home.reviewBacklog).toBe(409)
    expect(home.newBudget).toBe(0)
    expect(home.dailyReviewCap).toBe(50)

    // 未入队的到期词 dueAt 未被修改（明天仍到期）
    const db = getDb()
    const states = await db.states.where('deckId').equals(deck.id).toArray()
    expect(states.filter((state) => state.dueAt != null && state.dueAt <= NOW)).toHaveLength(459)
  }, 60_000)

  it('due=20, cap=50, goal=30 → 复习 20 / 新学 10 / backlog 0', async () => {
    const deck = await setupDeck(200)
    await seedDueStates(deck.id, 20)
    await updateSettings({ 'study.dailyGoal': 30, 'study.dailyReviewCap': 50 })

    const plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(30) // 20 复习 + 10 新学
    const breakdown = await getTodayBreakdown(NOW)
    expect(breakdown.review.planned).toBe(20)
    expect(breakdown.new.planned).toBe(10)

    const home = await getHomeStudyData(NOW)
    expect(home.dueCount).toBe(20)
    expect(home.plannedReview).toBe(20)
    expect(home.reviewBacklog).toBe(0)
    expect(home.newBudget).toBe(10)
  }, 60_000)

  it('cap=0 / 未设置（老库）= 不限，全部到期入队', async () => {
    const deck = await setupDeck(500)
    await seedDueStates(deck.id, 459)
    await updateSettings({ 'study.dailyGoal': 30, 'study.dailyReviewCap': 0 })
    let plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(459)
    let home = await getHomeStudyData(NOW)
    expect(home.reviewBacklog).toBe(0)
    expect(home.plannedReview).toBe(459)

    // 老库：删除设置行 → 默认 0（不限）
    await resetDatabase()
    const deck2 = await setupDeck(500)
    await seedDueStates(deck2.id, 30)
    await updateSettings({ 'study.dailyGoal': 30 })
    await getDb().settings.delete('study.dailyReviewCap')
    expect(await getDb().settings.get('study.dailyReviewCap')).toBeUndefined()
    expect((await getSettings())['study.dailyReviewCap']).toBe(0)
    plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(30)
    home = await getHomeStudyData(NOW)
    expect(home.dailyReviewCap).toBe(0)
  }, 90_000)

  it('改设置不影响已有 plan；forceRebuild 才按新 cap 重排；快照记录在 meta', async () => {
    const deck = await setupDeck(200)
    await seedDueStates(deck.id, 20)
    await updateSettings({ 'study.dailyGoal': 30, 'study.dailyReviewCap': 0 })
    const plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(30) // 20 review + 10 new

    await updateSettings({ 'study.dailyReviewCap': 5 })
    // 当天重进：沿用原 plan（复习集合不变）
    const reEnter = await getTodayPlan({ now: NOW + 1000 })
    expect(reEnter.id).toBe(plan.id)
    expect(reEnter.wordIds).toHaveLength(30)
    let home = await getHomeStudyData(NOW + 1000)
    expect(home.plannedReview).toBe(20)
    expect(home.dailyReviewCap).toBe(0) // plan 快照仍是 0（不限）
    expect(home.reviewBacklog).toBe(0)

    // 强制重建才按新 cap=5：复习 5 + 新学 25
    const rebuilt = await getTodayPlan({ now: NOW + 2000, forceRebuild: true, dailyGoal: 30 })
    expect(rebuilt.wordIds).toHaveLength(30)
    home = await getHomeStudyData(NOW + 2000)
    expect(home.plannedReview).toBe(5)
    expect(home.dailyReviewCap).toBe(5)
    expect(home.reviewBacklog).toBe(15) // 20 到期 − 今日入队 5
  }, 90_000)

  it('cap 只限制自动入队：手动加学词照常追加', async () => {
    const deck = await setupDeck(500)
    await seedDueStates(deck.id, 459)
    await updateSettings({ 'study.dailyGoal': 30, 'study.dailyReviewCap': 50 })
    const db = getDb()
    const far = (
      await db.words
        .where('[deckId+order]')
        .between([deck.id, -Infinity], [deck.id, Infinity])
        .offset(480)
        .limit(1)
        .toArray()
    )[0]!
    const plan = await getTodayPlan({ now: NOW, extraNewWordIds: [far.id] })
    expect(plan.wordIds).toHaveLength(51) // 50 review + 1 加学
    expect(plan.sources[far.id]).toBe('extra')
    const breakdown = await getTodayBreakdown(NOW)
    expect(breakdown.review.planned).toBe(50) // cap 未把加学算进复习
    expect(breakdown.totalPlanned).toBe(51)
  }, 60_000)

  it('设置校验：0–9999 整数合法；负数/越界/小数/字符串拒绝，读库非法回退 0', async () => {
    expect(normalizeSettingValue('study.dailyReviewCap', 0)).toBe(0)
    expect(normalizeSettingValue('study.dailyReviewCap', 50)).toBe(50)
    expect(normalizeSettingValue('study.dailyReviewCap', 9999)).toBe(9999)
    for (const invalid of [-1, 10000, 2.5, Number.NaN, '50']) {
      expect(normalizeSettingValue('study.dailyReviewCap', invalid)).toBeUndefined()
    }
    expect(settingOrDefault('study.dailyReviewCap', -1)).toBe(0)
    expect(normalizeDailyReviewCap('bad')).toBe(0)
    expect(normalizeDailyReviewCap(50)).toBe(50)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(updateSettings({ 'study.dailyReviewCap': -1 } as any)).rejects.toThrow(/不合法/)
  }, 60_000)
})
