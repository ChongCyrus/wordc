/** 0.3.93：最后 1 词同日重复「认识」——进度未完成时回炉、plan 不 completed；完成后才 completed */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createDeck,
  getDb,
  getTodayPlan,
  resetDatabase,
  submitRating,
  updateSettings,
} from '../../src/data'
import { localDateKey } from '../../src/core'
import type { DailyPlan, Word } from '../../src/core'

const NOW = new Date(2026, 10, 21, 10, 0, 0).getTime()
const HOUR = 3_600_000

async function setup() {
  await resetDatabase()
  const deck = await createDeck({ name: 'requeue', words: [{ headword: 'solo', meanings: [{ cn: '唯一', pos: 'n.' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id, 'study.dailyGoal': 1 })
  const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0] as Word
  const plan = await getTodayPlan({ deckId: deck.id, now: NOW })
  return { deck, word, plan }
}

async function resetPlan(planId: string, wordId: string) {
  const db = getDb()
  const plan = (await db.plans.get(planId)) as DailyPlan
  await db.plans.put({
    ...plan,
    wordIds: [wordId],
    index: 0,
    sources: { [wordId]: 'goal' },
    ratings: [],
    completedAt: null,
    updatedAt: NOW,
  })
}

describe('0.3.93 · 最后 1 词同日重复 familiar', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('未完成（progress<1）→ requeue-vague、plan 未完成且 wordIds 增加', async () => {
    const { word, plan } = await setup()
    // 首评 forgot：今日进度 20%
    await submitRating(word.id, 'forgot', NOW, { planId: plan.id })
    await resetPlan(plan.id, word.id)
    const before = (await getDb().plans.get(plan.id))!

    const res = await submitRating(word.id, 'familiar', NOW + HOUR, { planId: plan.id })
    expect(res.longTermUpdate).toBe(false)
    expect(res.requeue).toBe('requeue-vague')
    const after = (await getDb().plans.get(plan.id))!
    expect(after.completedAt).toBeNull()
    expect(after.wordIds.length).toBe(before.wordIds.length + 1)
    expect(after.index).toBe(1)
  })

  it('QA 场景：回炉 occurrence 上 core 判 completesToday 仍强制再回炉一次', async () => {
    const { word, plan } = await setup()
    await resetPlan(plan.id, word.id)
    await submitRating(word.id, 'forgot', NOW, { planId: plan.id })
    // 制造 [word,word] index1 且 source=requeue（首评 forgot 已插入回炉）
    const requeued = (await getDb().plans.get(plan.id))!
    expect(requeued.wordIds).toEqual([word.id, word.id])
    expect(requeued.index).toBe(1)
    expect(requeued.sources[word.id]).toBe('requeue')
    // 模拟 core 在同日 familiar 上判 completesToday=true
    const state = (await getDb().states.get(word.id))!
    const today = localDateKey(NOW + HOUR)
    await getDb().states.put({
      ...state,
      lastReviewedAt: NOW,
      lastRating: 'forgot',
      todayProgress: 1,
      todayProgressDate: today,
      todayProgressLevel: 5,
      canFinishToday: true,
      sameDayDate: today,
      sameDayCount: 1,
    })
    const res = await submitRating(word.id, 'familiar', NOW + HOUR, { planId: plan.id })
    const after = (await getDb().plans.get(plan.id))!
    expect(res.requeue === 'none' || res.requeue === 'requeue-vague').toBe(true)
    expect(after.completedAt).toBeNull()
    expect(after.wordIds.length).toBe(requeued.wordIds.length + 1)
    expect(after.index).toBe(2)
    const diag = (await getDb().meta.get('diag.lastSubmitRating'))!.value as Record<string, unknown>
    expect(diag.forceRequeueOnRequeuedOccurrence).toBe(true)
    expect(diag.insertRequeue).toBe(true)
  })

  it('已完成（progress=1）→ requeue=none、plan completed、wordIds 不再增加', async () => {
    const { word, plan } = await setup()
    await submitRating(word.id, 'forgot', NOW, { planId: plan.id })
    await resetPlan(plan.id, word.id)
    // 模拟今日进度已满（v2 档位也置为可完成）
    const state = (await getDb().states.get(word.id))!
    const today = localDateKey(NOW + HOUR)
    await getDb().states.put({
      ...state,
      lastReviewedAt: NOW,
      todayProgress: 1,
      todayProgressDate: today,
      todayProgressLevel: 5,
      canFinishToday: true,
      sameDayDate: today,
      sameDayCount: 1,
    })
    const before = (await getDb().plans.get(plan.id))!

    const res = await submitRating(word.id, 'familiar', NOW + HOUR, { planId: plan.id })
    expect(res.requeue).toBe('none')
    const after = (await getDb().plans.get(plan.id))!
    expect(after.completedAt).not.toBeNull()
    expect(after.wordIds).toEqual(before.wordIds)
    expect(after.index).toBe(1)
  })
})
