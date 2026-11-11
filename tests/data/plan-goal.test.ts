import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDeck,
  getDb,
  getHomeStudyData,
  getSettings,
  getTodayPlan,
  rateInPlan,
  recomputePlanForGoal,
  resetDatabase,
  submitRating,
  updateDailyGoalAndResync,
  updateSettings,
} from '../../src/data'
import { localDateKey } from '../../src/core'

const NOW = new Date(2026, 10, 11, 10, 0, 0).getTime()
const DAY = 86_400_000

async function setupDeck(wordCount = 100) {
  const deck = await createDeck({
    name: '学习量重算词库',
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `gw${index}`,
      meanings: [{ pos: 'n.', cn: `词${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

beforeEach(async () => {
  await resetDatabase()
})

describe('task-34：修改每日学习量 → 今日计划立即重算', () => {
  it('30 → 50：队尾追加 20 个新学词（按词库顺序），总数 +20', async () => {
    await setupDeck(100)
    await updateSettings({ 'study.dailyGoal': 30 })
    const plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(30)
    const firstThirty = plan.wordIds.slice()

    const result = await updateDailyGoalAndResync(50, { now: NOW + 1000 })
    expect(result.plan).toBeTruthy()
    expect(result.added).toBe(20)
    expect(result.removed).toBe(0)
    expect(result.total).toBe(50)
    expect(result.newBudget).toBe(50)
    expect((await getSettings())['study.dailyGoal']).toBe(50)

    const updated = (await getDb().plans.get(plan.id))!
    expect(updated.wordIds).toHaveLength(50)
    expect(updated.wordIds.slice(0, 30)).toEqual(firstThirty) // 原队列顺序不变
    expect(updated.wordIds.slice(30)).toHaveLength(20)
    expect(updated.wordIds.slice(30).every((id) => !firstThirty.includes(id))).toBe(true)
    expect(updated.goals).toMatchObject({ dailyGoal: 50, newBudget: 50, dueCount: 0 })

    // 首页事实同步：plan 总数/剩余随新目标变大
    const home = await getHomeStudyData(NOW + 2000)
    expect(home.plan?.wordIds).toHaveLength(50)
    expect(home.newBudget).toBe(50)
    expect(home.remaining).toBe(50)
  }, 60_000)

  it('50 → 10：删队尾未学新词（40 个），已评分/回炉/当前词保留', async () => {
    await setupDeck(100)
    await updateSettings({ 'study.dailyGoal': 50 })
    const plan = await getTodayPlan({ now: NOW })
    expect(plan.wordIds).toHaveLength(50)
    // 学 3 个（认识）+ 第 4 个（模糊 → 回炉插入）
    for (let i = 0; i < 3; i += 1) {
      await rateInPlan({ wordId: plan.wordIds[i]!, rating: 'familiar', now: NOW + 1000 + i })
    }
    await rateInPlan({ wordId: plan.wordIds[3]!, rating: 'vague', now: NOW + 2000 })
    const before = (await getDb().plans.get(plan.id))!
    expect(before.index).toBe(4)
    expect(before.wordIds.filter((id) => id === plan.wordIds[3]!).length).toBe(2) // 回炉重复

    const result = await updateDailyGoalAndResync(10, { now: NOW + 3000 })
    expect(result.removed).toBe(40)
    expect(result.added).toBe(0)
    // 新学词去重后 = 新预算 10；回炉重复项保留 → 队列条目 11
    expect(result.newCount).toBe(10)
    expect(result.total).toBe(11)
    const after = (await getDb().plans.get(plan.id))!
    expect(after.wordIds).toHaveLength(11)
    expect(new Set(after.wordIds).size).toBe(10)
    expect(after.goals).toMatchObject({ dailyGoal: 10, newBudget: 10 })
    expect(after.index).toBe(4) // 当前进度不变
    // 已评分词 + 回炉词全部保留
    for (let i = 0; i < 4; i += 1) {
      expect(after.wordIds).toContain(plan.wordIds[i]!)
    }
    expect(after.wordIds.filter((id) => id === plan.wordIds[3]!).length).toBe(2)
    expect(after.sources[plan.wordIds[3]!]).toBe('requeue')
  }, 60_000)

  it('复习词永远不删：改到比复习数还小 → 新学=0、复习全保留', async () => {
    await setupDeck(100)
    // 昨天用「忘记」评 5 个 → 今天到期成为复习词
    const initial = await getTodayPlan({ now: NOW - DAY })
    const reviewIds = initial.wordIds.slice(0, 5)
    for (const wordId of reviewIds) {
      await submitRating(wordId, 'forgot', NOW - DAY + 1000)
    }
    await updateSettings({ 'study.dailyGoal': 30 })
    const plan = await getTodayPlan({ now: NOW })
    expect(plan.goals.dueCount).toBe(5)
    expect(plan.wordIds).toHaveLength(30) // 5 复习 + 25 新学
    expect(plan.wordIds.slice(0, 5).sort()).toEqual(reviewIds.slice().sort())

    const result = await updateDailyGoalAndResync(1, { now: NOW + 1000 })
    expect(result.reviewCount).toBe(5)
    expect(result.newBudget).toBe(0)
    expect(result.removed).toBe(25)
    expect(result.total).toBe(5)
    const after = (await getDb().plans.get(plan.id))!
    expect(after.wordIds.sort()).toEqual(reviewIds.slice().sort())
    expect(after.goals).toMatchObject({ dailyGoal: 1, dueCount: 5, newBudget: 0 })
  }, 60_000)

  it('幂等：同一目标重复调用 → added/removed=0，plan 不变', async () => {
    await setupDeck(100)
    await updateSettings({ 'study.dailyGoal': 30 })
    const plan = await getTodayPlan({ now: NOW })
    const first = await updateDailyGoalAndResync(40, { now: NOW + 1000 })
    expect(first.added).toBe(10)
    const afterFirst = (await getDb().plans.get(plan.id))!
    const second = await updateDailyGoalAndResync(40, { now: NOW + 2000 })
    expect(second.added).toBe(0)
    expect(second.removed).toBe(0)
    expect(second.total).toBe(40)
    const afterSecond = (await getDb().plans.get(plan.id))!
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt) // 未写库
    expect(afterSecond.wordIds).toEqual(afterFirst.wordIds)
  }, 60_000)

  it('recomputePlanForGoal 直接调用（指定 planId）+ 非法目标抛错', async () => {
    await setupDeck(40)
    await updateSettings({ 'study.dailyGoal': 20 })
    const plan = await getTodayPlan({ now: NOW })
    const result = await recomputePlanForGoal({ planId: plan.id, newGoal: 25, now: NOW + 1000 })
    expect(result.added).toBe(5)
    expect(result.total).toBe(25)
    // 非法目标
    await expect(
      recomputePlanForGoal({ planId: plan.id, newGoal: 0, now: NOW + 2000 }),
    ).rejects.toThrow(/1–9999/)
    await expect(
      recomputePlanForGoal({ planId: plan.id, newGoal: 2.5, now: NOW + 2000 }),
    ).rejects.toThrow(/1–9999/)
  }, 60_000)

  it('跨天：今天没有 plan 时只写设置，次日建队使用新值', async () => {
    await setupDeck(100)
    await updateSettings({ 'study.dailyGoal': 30 })
    const day1 = await getTodayPlan({ now: NOW })
    expect(day1.goals.dailyGoal).toBe(30)

    const result = await updateDailyGoalAndResync(60, { now: NOW + DAY })
    expect(result.plan).toBeNull() // 明天还没有 plan
    expect((await getSettings())['study.dailyGoal']).toBe(60)

    const day2 = await getTodayPlan({ now: NOW + DAY })
    expect(day2.date).toBe(localDateKey(NOW + DAY))
    expect(day2.goals.dailyGoal).toBe(60)
    expect(day2.wordIds).toHaveLength(60)
  }, 60_000)
})
