/** task-254：临时复习（一次性 session，practice 零写库 / rate 正常 / rate-only 不改复习时间） */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createDeck,
  getDb,
  getTodayPlan,
  rateTempReview,
  resetDatabase,
  startTempReview,
  submitRating,
  updateSettings,
} from '../../src/data'
import type { Word } from '../../src/core'

async function setup() {
  await resetDatabase()
  const deck = await createDeck({
    name: 'temp',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲', pos: 'n.' }] },
      { headword: 'beta', meanings: [{ cn: '乙', pos: 'v.' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const words = await getDb().words.where('deckId').equals(deck.id).toArray()
  return { deck, words: words as Word[] }
}

async function counts() {
  const db = getDb()
  return {
    states: await db.states.count(),
    logs: await db.reviewLogs.count(),
    plans: await db.plans.count(),
    meta: await db.meta.count(),
  }
}

async function snapshotState(wordId: string) {
  const state = await getDb().states.get(wordId)
  return state ? { ...state } : null
}

describe('task-254 · 临时复习', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('startTempReview：去重/过滤不存在/保持顺序，不建 plan、不写 state/log', async () => {
    const { words, deck } = await setup()
    const before = await counts()
    const session = await startTempReview({
      wordIds: [words[1]!.id, 'missing', words[0]!.id, words[1]!.id],
      recordMode: 'practice',
    })
    expect(session.wordIds).toEqual([words[1]!.id, words[0]!.id])
    expect(session.words.map((word) => word.id)).toEqual(session.wordIds)
    expect(session.recordMode).toBe('practice')
    expect(await counts()).toEqual(before)
    await getTodayPlan({ deckId: deck.id })
    expect((await getDb().plans.where('deckId').equals(deck.id).toArray())[0]?.ratings).toEqual([])
  })

  it('practice：完全不写库（state/log/plan/meta 均不变）', async () => {
    const { words } = await setup()
    const before = await counts()
    const session = await startTempReview({ wordIds: [words[0]!.id], recordMode: 'practice' })
    const result = await rateTempReview({ wordId: session.wordIds[0]!, rating: 'familiar', recordMode: 'practice' })
    expect(result).toBeNull()
    expect(await counts()).toEqual(before)
    expect(await snapshotState(words[0]!.id)).toBeNull()
  })

  it('rate：正常更新 DHP 与 reviewLog，但不推进/创建今日 plan', async () => {
    const { words, deck } = await setup()
    const wordId = words[0]!.id
    await submitRating(wordId, 'familiar', Date.now() - 86_400_000)
    const stateBefore = (await snapshotState(wordId))!
    const plan = await getTodayPlan({ deckId: deck.id })
    const before = await counts()
    const result = await rateTempReview({ wordId, rating: 'forgot', recordMode: 'rate' })
    expect(result).not.toBeNull()
    const stateAfter = (await snapshotState(wordId))!
    expect(stateAfter.dueAt).not.toBe(stateBefore.dueAt)
    expect(stateAfter.lastRating).toBe('forgot')
    const after = await counts()
    expect(after.logs).toBe(before.logs + 1)
    expect(result!.log.scheduleMode).toBeUndefined()
    const planAfter = (await getDb().plans.get(plan.id))!
    expect(planAfter.ratings).toEqual([])
    expect(planAfter.index).toBe(plan.index)
  })

  it('rate-only：调度/showing 字段全保留，只写 reviewLog(scheduleMode=skip)', async () => {
    const { words, deck } = await setup()
    const wordId = words[0]!.id
    await submitRating(wordId, 'familiar', Date.now() - 86_400_000)
    const stateBefore = (await snapshotState(wordId))!
    const plan = await getTodayPlan({ deckId: deck.id })
    const before = await counts()
    const result = await rateTempReview({ wordId, rating: 'forgot', recordMode: 'rate-only' })
    expect(result).not.toBeNull()
    const stateAfter = (await snapshotState(wordId))!
    const keys: Array<keyof typeof stateBefore> = [
      'stability', 'difficulty', 'dueAt', 'nextIntervalDays', 'phase', 'firstSeenAt',
      'lastReviewedAt', 'lastRating', 'retrievability', 'reps', 'lapses',
      'sameDayCount', 'sameDayDate', 'todayProgress', 'todayProgressDate',
      'todayProgressLevel', 'canFinishToday',
    ]
    for (const key of keys) expect(stateAfter[key]).toEqual(stateBefore[key])
    expect(result!.log.scheduleMode).toBe('skip')
    expect(result!.log.longTermUpdate).toBe(false)
    expect(result!.log.stabilityAfter).toBe(result!.log.stabilityBefore)
    expect(await counts()).toMatchObject({ ...before, logs: before.logs + 1 })
    const planAfter = (await getDb().plans.get(plan.id))!
    expect(planAfter.ratings).toEqual([])
  })

  it('submitRating skip 即使传 planId 也不推进 plan', async () => {
    const { words, deck } = await setup()
    const wordId = words[0]!.id
    const plan = await getTodayPlan({ deckId: deck.id })
    await submitRating(wordId, 'familiar', Date.now(), { planId: plan.id, scheduleMode: 'skip' })
    const planAfter = (await getDb().plans.get(plan.id))!
    expect(planAfter.ratings).toEqual([])
    expect(planAfter.index).toBe(plan.index)
  })
})
