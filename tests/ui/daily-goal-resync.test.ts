/**
 * 每日学习量变更 → 今日计划实时重算（task-34/35 集成）：
 * 用 fake-indexeddb 驱动真实 data `updateDailyGoalAndResync`，验证
 * 增大追加 / 减小删除尾部未学、当前词保留、复习占满新学=0、首页数字即时变化、w-c 快照不受影响。
 */
import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'
import { deriveHomeState } from '../../src/core'
import {
  ensureBuiltinDecks,
  getDb,
  getHomeStudyData,
  getTodayPlan,
  loadSessionSnapshot,
  rateInPlan,
  resetDatabase,
  saveSessionSnapshot,
  updateDailyGoalAndResync,
} from '../../src/data'
import { buildGoalResyncMessage } from '../../src/app/hooks/useDailyGoal'

const NOW = new Date(2026, 10, 11, 10, 0, 0).getTime()

async function homeFacts() {
  const data = await getHomeStudyData(NOW)
  const state = deriveHomeState({
    plan: data.plan as unknown as Parameters<typeof deriveHomeState>[0]['plan'],
    dueCount: data.dueCount,
    dailyGoal: data.dailyGoal,
    hasDeck: data.hasDeck,
    hasLearnableWord: data.hasLearnableWord,
    overdueLeft: data.overdueLeft,
  })
  return { data, state }
}

describe('每日学习量实时同步（task-35）', () => {
  beforeEach(async () => {
    await resetDatabase()
    await ensureBuiltinDecks()
  })

  it('增大目标：今日 plan 追加新学词，total/首页剩余立即变大', async () => {
    const data0 = await getHomeStudyData(NOW)
    const plan = await getTodayPlan({ deckId: data0.deckId, dailyGoal: 10, now: NOW })
    const before = plan.wordIds.length
    expect(before).toBe(10)

    const result = await updateDailyGoalAndResync(18, { now: NOW })
    expect(result.plan).not.toBeNull()
    expect(result.added).toBe(8)
    expect(result.removed).toBe(0)
    expect(result.total).toBe(before + 8)
    expect(result.plan!.wordIds.length).toBe(before + 8)

    // 首页事实/6 态立即反映
    const { data, state } = await homeFacts()
    expect(data.dailyGoal).toBe(18)
    expect(data.plan!.wordIds.length).toBe(before + 8)
    expect(state.kind).toBe('fresh')
    expect(buildGoalResyncMessage(result)).toContain('+8 词')
  })

  it('减小目标：只删除队尾未学新词，当前词保留、index 不变', async () => {
    const data0 = await getHomeStudyData(NOW)
    await getTodayPlan({ deckId: data0.deckId, dailyGoal: 10, now: NOW })
    // 学 3 个词
    for (let i = 0; i < 3; i += 1) {
      const current = await getTodayPlan({ deckId: data0.deckId, now: NOW })
      const wordId = current.wordIds[current.index]!
      await rateInPlan({ wordId, rating: 'familiar', now: NOW, planId: current.id })
    }
    const mid = await getTodayPlan({ deckId: data0.deckId, now: NOW })
    const currentWord = mid.wordIds[mid.index]!
    const currentIndex = mid.index

    const result = await updateDailyGoalAndResync(5, { now: NOW })
    expect(result.removed).toBeGreaterThan(0)
    expect(result.plan).not.toBeNull()
    // 当前词仍在原 index，没被删
    expect(result.plan!.wordIds[currentIndex]).toBe(currentWord)
    expect(result.plan!.index).toBe(currentIndex)
    expect(result.plan!.wordIds.length).toBeLessThan(mid.wordIds.length)
    expect(buildGoalResyncMessage(result)).toContain('-')

    // 首页「当前/总数」跟随
    const { data } = await homeFacts()
    expect(data.plan!.wordIds.length).toBe(result.plan!.wordIds.length)
    expect(data.remaining).toBe(result.plan!.wordIds.length - currentIndex)
  })

  it('减到比复习数小：新学=0 且文案提示「今日新学为 0」', async () => {
    const data0 = await getHomeStudyData(NOW)
    // 构造 3 个已学且今天到期的复习词
    const db = getDb()
    const words = await db.words
      .where('[deckId+order]')
      .between([data0.deckId, -Infinity], [data0.deckId, Infinity])
      .limit(3)
      .toArray()
    for (const word of words) {
      await db.states.put({
        wordId: word.id,
        deckId: word.deckId,
        phase: 'review',
        stability: 1,
        difficulty: 5,
        reps: 1,
        lapses: 0,
        firstSeenAt: NOW - 10 * 86_400_000,
        lastReviewedAt: NOW - 2 * 86_400_000,
        dueAt: NOW - 86_400_000,
        nextIntervalDays: 1,
        retrievability: 0.5,
        lastRating: 'familiar',
        sameDayCount: 0,
        sameDayDate: '',
        meaningStats: {},
        sameDayRequeued: 0,
        createdAt: NOW - 10 * 86_400_000,
        updatedAt: NOW - 2 * 86_400_000,
      } as never)
    }
    const plan = await getTodayPlan({ deckId: data0.deckId, dailyGoal: 5, now: NOW })
    expect(plan.goals.dueCount).toBe(3)

    const result = await updateDailyGoalAndResync(1, { now: NOW })
    expect(result.reviewCount).toBe(3)
    expect(result.newBudget).toBe(0)
    expect(result.newCount).toBe(0)
    // 复习词不删
    expect(result.plan!.wordIds.length).toBeGreaterThanOrEqual(3)
    expect(buildGoalResyncMessage(result)).toContain('复习已占满目标，今日新学为 0')
  })

  it('改设置不打断 w-c：重算前后 session 快照保持一致', async () => {
    const data0 = await getHomeStudyData(NOW)
    const plan = await getTodayPlan({ deckId: data0.deckId, dailyGoal: 10, now: NOW })
    const wordId = plan.wordIds[0]!
    const snapshot = {
      wordId,
      deckId: plan.deckId,
      wcCounts: { [`${wordId}#M1`]: 2 },
      wcActiveMeaningId: `${wordId}#M1`,
      stage: 'memory' as const,
      startedAt: NOW - 60_000,
      updatedAt: NOW - 1000,
    }
    await saveSessionSnapshot(snapshot)

    await updateDailyGoalAndResync(3, { now: NOW })

    const restored = await loadSessionSnapshot(wordId)
    expect(restored).not.toBeNull()
    expect(restored?.wcCounts).toEqual(snapshot.wcCounts)
    expect(restored?.stage).toBe('memory')
  })
})
