/**
 * plan 驱动续学 / 首页 6 态 / 回退改判的集成测试（task-30）。
 * 用 fake-indexeddb 驱动 data 层真实 plan API + core.deriveHomeState，
 * 验证 useStudySession/useHomeStudy 所依赖的契约（不渲染 React）。
 */
import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'
import { deriveHomeState } from '../../src/core'
import {
  ensureBuiltinDecks,
  getHomeStudyData,
  getLastRatingRecord,
  getTodayPlan,
  rateInPlan,
  reRateInPlan,
  resetDatabase,
  undoLastRating,
} from '../../src/data'

const NOW = new Date(2026, 10, 11, 10, 0, 0).getTime()
const GOAL = 3

async function homeState() {
  const data = await getHomeStudyData(NOW)
  return {
    data,
    state: deriveHomeState({
      plan: data.plan as unknown as Parameters<typeof deriveHomeState>[0]['plan'],
      dueCount: data.dueCount,
      dailyGoal: data.dailyGoal,
      hasDeck: data.hasDeck,
      hasLearnableWord: data.hasLearnableWord,
      overdueLeft: data.overdueLeft,
    }),
  }
}

describe('plan 驱动续学（task-30）', () => {
  beforeEach(async () => {
    await resetDatabase()
    await ensureBuiltinDecks()
  })

  it('首次进入：无 plan → fresh（待复习 0 / 待新学 = dailyGoal）', async () => {
    const { data, state } = await homeState()
    expect(data.plan).toBeNull()
    expect(state.kind).toBe('fresh')
    if (state.kind === 'fresh') {
      expect(state.pendingReview).toBe(0)
      expect(state.pendingNew).toBe(data.dailyGoal)
    }
  })

  it('建 plan 后评分推进：homeState fresh → ongoing；退出再进 plan 不重排', async () => {
    const deckId = (await getHomeStudyData(NOW)).deckId
    expect(deckId).toBeTruthy()
    const created = await getTodayPlan({ deckId, dailyGoal: GOAL, now: NOW })
    expect(created.wordIds).toHaveLength(GOAL)
    expect(created.index).toBe(0)

    // 学 1 个词 → ongoing
    const firstWord = created.wordIds[0]!
    await rateInPlan({ wordId: firstWord, rating: 'familiar', now: NOW, planId: created.id })
    const ongoing = await homeState()
    expect(ongoing.state.kind).toBe('ongoing')
    if (ongoing.state.kind === 'ongoing') {
      expect(ongoing.state.index).toBe(1)
      expect(ongoing.state.total).toBe(GOAL)
      expect(ongoing.state.remaining).toBe(GOAL - 1)
    }

    // 退出再进（再次 getTodayPlan）→ 同一 plan、同一顺序、index 保留
    const resumed = await getTodayPlan({ deckId, dailyGoal: GOAL, now: NOW })
    expect(resumed.id).toBe(created.id)
    expect(resumed.wordIds).toEqual(created.wordIds)
    expect(resumed.index).toBe(1)
  })

  it('学完队列 → done（completedAt 写入）', async () => {
    const deckId = (await getHomeStudyData(NOW)).deckId
    const plan = await getTodayPlan({ deckId, dailyGoal: GOAL, now: NOW })
    let current = plan
    for (let i = 0; i < GOAL; i += 1) {
      const wordId = current.wordIds[current.index]!
      const result = await rateInPlan({ wordId, rating: 'familiar', now: NOW, planId: current.id })
      expect(result.plan).not.toBeNull()
      current = result.plan!
    }
    expect(current.completedAt).not.toBeNull()
    const { state } = await homeState()
    expect(state.kind).toBe('done')
  })

  it('回退浏览：getLastRatingRecord 返回原评分；不调用 undo 时 plan/状态不变', async () => {
    const deckId = (await getHomeStudyData(NOW)).deckId
    const plan = await getTodayPlan({ deckId, dailyGoal: GOAL, now: NOW })
    const firstWord = plan.wordIds[0]!
    const rated = await rateInPlan({
      wordId: firstWord,
      rating: 'vague',
      now: NOW,
      planId: plan.id,
    })
    const indexAfterRate = rated.plan!.index

    const snapshot = await getLastRatingRecord(firstWord, NOW)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.log.rating).toBe('vague')
    // vague 会回炉插入到 index+gap，最近一次出现位置 = 3
    expect(snapshot?.planIndex).toBe(3)

    // 只浏览不撤销 → plan 不变
    const still = await getTodayPlan({ deckId, dailyGoal: GOAL, now: NOW })
    expect(still.index).toBe(indexAfterRate)
    expect(still.completedAt).toBeNull()
  })

  it('撤销：undoLastRating 恢复评分前状态并回退 index', async () => {
    const deckId = (await getHomeStudyData(NOW)).deckId
    const plan = await getTodayPlan({ deckId, dailyGoal: GOAL, now: NOW })
    const firstWord = plan.wordIds[0]!
    await rateInPlan({ wordId: firstWord, rating: 'familiar', now: NOW, planId: plan.id })

    const undo = await undoLastRating({ wordId: firstWord, planId: plan.id, now: NOW })
    expect(undo).not.toBeNull()
    expect(undo!.plan.index).toBe(0)
    expect(undo!.plan.completedAt).toBeNull()
    // 已被撤销的日志不再作为可改判记录
    expect(await getLastRatingRecord(firstWord, NOW)).toBeNull()
  })

  it('改判：reRateInPlan 内部先撤销再按新 rating 重评，新日志带 correctedBy', async () => {
    const deckId = (await getHomeStudyData(NOW)).deckId
    const plan = await getTodayPlan({ deckId, dailyGoal: GOAL, now: NOW })
    const firstWord = plan.wordIds[0]!
    await rateInPlan({ wordId: firstWord, rating: 'familiar', now: NOW, planId: plan.id })

    // UI 只浏览不撤销；点新评分时才调 reRateInPlan（内部含 undo）
    const reRated = await reRateInPlan({
      wordId: firstWord,
      rating: 'forgot',
      now: NOW,
      planId: plan.id,
    })
    expect(reRated).not.toBeNull()
    expect(reRated!.plan.index).toBe(1)
    const after = await getLastRatingRecord(firstWord, NOW)
    expect(after?.log.rating).toBe('forgot')
    expect(after?.log.correctedBy).toBeTruthy()
  })
})
