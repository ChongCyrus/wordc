import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { BRAND } from '../../src/app/brand'
import {
  ensureBuiltinDecks,
  getDb,
  getHomeStudyData,
  getTodayPlan,
  resetDatabase,
  updateSettings,
} from '../../src/data'
import type { WordState } from '../../src/core'

const DAY = 86_400_000
const NOW = new Date(2026, 10, 11, 10, 0, 0).getTime()
const PRIMARY = BRAND.defaultDeckId
const DUE_TOTAL = 459

async function seedDueWords(count: number): Promise<void> {
  const db = getDb()
  const words = await db.words
    .where('[deckId+order]')
    .between([PRIMARY, -Infinity], [PRIMARY, Infinity])
    .limit(count)
    .toArray()
  const states: WordState[] = words.map((word) => ({
    wordId: word.id,
    deckId: word.deckId,
    phase: 'review',
    stability: 1,
    difficulty: 5,
    reps: 1,
    lapses: 0,
    firstSeenAt: NOW - 10 * DAY,
    lastReviewedAt: NOW - 2 * DAY,
    dueAt: NOW - DAY,
    nextIntervalDays: 1,
    retrievability: 0.5,
    lastRating: 'familiar',
    sameDayCount: 0,
    sameDayDate: '',
    meaningStats: {},
    sameDayRequeued: 0,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 2 * DAY,
  }))
  await db.states.bulkPut(states)
}

describe('无 plan 时首页积压（task-54）', () => {
  beforeEach(async () => {
    await resetDatabase()
    await ensureBuiltinDecks()
    await updateSettings({
      'data.selectedDeckId': PRIMARY,
      'study.dailyGoal': 30,
    })
  })

  it('无 plan + due=459 + cap=50 → plannedReview=50、backlog=409', async () => {
    await seedDueWords(DUE_TOTAL)
    await updateSettings({ 'study.dailyReviewCap': 50 })

    const data = await getHomeStudyData(NOW)
    expect(data.plan).toBeNull()
    expect(data.dueCount).toBe(DUE_TOTAL)
    expect(data.plannedReview).toBe(50) // 预算入队 = min(459, 50)
    expect(data.reviewBacklog).toBe(409)
    expect(data.dailyReviewCap).toBe(50)
    // task-54：新学预算 = max(0, goal − 入队复习数) = max(0, 30−50) = 0
    expect(data.newBudget).toBe(0)
  })

  it('无 plan + cap=0（不限）→ plannedReview=dueCount、backlog=0', async () => {
    await seedDueWords(DUE_TOTAL)
    await updateSettings({ 'study.dailyReviewCap': 0 })

    const data = await getHomeStudyData(NOW)
    expect(data.plan).toBeNull()
    expect(data.dueCount).toBe(DUE_TOTAL)
    expect(data.plannedReview).toBe(DUE_TOTAL)
    expect(data.reviewBacklog).toBe(0)
    expect(data.newBudget).toBe(0)
  })

  it('无 plan + due=100 + cap=50 + goal=80 → planned=50、backlog=50、newBudget=30', async () => {
    await seedDueWords(100)
    await updateSettings({ 'study.dailyReviewCap': 50, 'study.dailyGoal': 80 })
    const data = await getHomeStudyData(NOW)
    expect(data.plan).toBeNull()
    expect(data.dueCount).toBe(100)
    expect(data.plannedReview).toBe(50)
    expect(data.reviewBacklog).toBe(50)
    expect(data.newBudget).toBe(30) // 80 − 50，不是 0
  })

  it('有 plan 时口径不变：backlog = dueCount − plan 实际入队数', async () => {
    await seedDueWords(DUE_TOTAL)
    await updateSettings({ 'study.dailyReviewCap': 50 })
    const plan = await getTodayPlan({ deckId: PRIMARY, dailyGoal: 30, now: NOW })
    const data = await getHomeStudyData(NOW)
    expect(data.plan).not.toBeNull()
    expect(data.plannedReview).toBe(plan.goals.dueCount === 0 ? 0 : Math.min(data.dueCount, 50))
    expect(data.reviewBacklog).toBe(Math.max(0, data.dueCount - data.plannedReview))
    // 有 plan：新学预算用建队快照
    expect(data.newBudget).toBe(plan.goals.newBudget)
  })
})
