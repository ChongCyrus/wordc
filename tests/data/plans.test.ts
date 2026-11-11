import './test-utils'

import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearAllData,
  clearPlan,
  cleanupOldPlans,
  completePlan,
  createDeck,
  exportMigration,
  getCurrentWordId,
  getDb,
  getHomeStudyData,
  getLastReviewSnapshot,
  getStatsOverview,
  getTodayPlan,
  hasResumablePlan,
  importMigration,
  rateInPlan,
  reRateInPlan,
  resetDatabase,
  saveTodayPlan,
  setPlanIndex,
  stableStringify,
  submitRating,
  undoLastRating,
  updateSettings,
} from '../../src/data'
import type { DailyPlan } from '../../src/data'
import { localDateKey } from '../../src/core'

const NOW = new Date(2026, 10, 11, 10, 0, 0).getTime()

/** AC5 深比较：时间戳字段除外（SPEC-v2 §7.2） */
function withoutTimeFields<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const copy = { ...value }
  delete copy.createdAt
  delete copy.updatedAt
  delete copy.importedAt
  delete copy.sameDayDate
  return copy
}
const DAY = 86_400_000

async function setupDeck(wordCount = 20) {
  const db = getDb()
  const deck = await createDeck({
    name: '计划测试词库',
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `word${index}`,
      meanings: [{ pos: 'n.', cn: `词${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return { db, deck }
}

beforeEach(async () => {
  await resetDatabase()
})

describe('建队 / 续学（SPEC-v2 §6）', () => {
  it('getTodayPlan 幂等：同一天同词库返回同一份；wordIds = 复习 + 新学', async () => {
    const { deck } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    expect(plan.id).toBe(`${localDateKey(NOW)}:${deck.id}`)
    expect(plan.wordIds).toHaveLength(5)
    expect(plan.index).toBe(0)
    expect(plan.goals).toEqual({ dailyGoal: 5, dueCount: 0, newBudget: 5, extraCount: 0 })
    expect(plan.ratings).toEqual([])
    expect(getCurrentWordId(plan)).toBe(plan.wordIds[0])

    const second = await getTodayPlan({ now: NOW + 60_000 })
    expect(second.createdAt).toBe(plan.createdAt) // 同一份，不重排
    expect(second.wordIds).toEqual(plan.wordIds)
    expect((await getDb().meta.get('plan.activeId'))!.value).toBe(plan.id)
  }, 60_000)

  it('hasResumablePlan：index=0 为 false，学一个后 true，完成后 false', async () => {
    await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    expect(await hasResumablePlan({ now: NOW })).toBe(false)
    await rateInPlan({ wordId: plan.wordIds[0]!, rating: 'familiar', now: NOW + 1000 })
    expect(await hasResumablePlan({ now: NOW })).toBe(true)
    await completePlan(plan.id, NOW + 2000)
    expect(await hasResumablePlan({ now: NOW })).toBe(false)
  }, 60_000)

  it('跨天自动重建：旧 plan 保留、新 plan 新日期；旧未评分词无副作用', async () => {
    const { deck } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 3 })
    const day1 = await getTodayPlan({ now: NOW })
    await rateInPlan({ wordId: day1.wordIds[0]!, rating: 'familiar', now: NOW + 1000 })

    const day2 = await getTodayPlan({ now: NOW + DAY })
    expect(day2.id).not.toBe(day1.id)
    expect(day2.date).toBe(localDateKey(NOW + DAY))
    expect(day2.deckId).toBe(deck.id)
    const db = getDb()
    expect(await db.plans.get(day1.id)).toBeTruthy() // 旧 plan 保留
    expect(day2.wordIds).not.toEqual(day1.wordIds) // 旧已学词不再进新队（familiar 长间隔）
  }, 60_000)
})

describe('评分 + 回炉（单事务三写）', () => {
  it('rateInPlan：states + reviewLogs(含 stateBefore) + plan 同一事务落库', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!

    const result = await rateInPlan({ wordId, rating: 'familiar', now: NOW + 1000 })
    expect(result.plan!.index).toBe(1)
    expect(result.plan!.ratings).toHaveLength(1)
    expect(result.plan!.ratings[0]!.wordId).toBe(wordId)

    const log = (await db.reviewLogs.where('wordId').equals(wordId).toArray())[0]!
    expect(log.stateBefore).toBeNull() // 首评前无 state → null（撤销时删 state）
    expect(await db.states.get(wordId)).toBeTruthy()
    expect((await db.meta.get('plan.activeId'))!.value).toBe(plan.id)
  }, 60_000)

  it('模糊/忘记回炉：同 wordId 插入较后位置（允许重复），来源记 requeue', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    const before = plan.wordIds.length

    const result = await rateInPlan({ wordId, rating: 'vague', now: NOW + 1000 })
    const next = result.plan!
    expect(next.wordIds.length).toBe(before + 1)
    expect(next.wordIds.filter((id) => id === wordId)).toHaveLength(2)
    expect(next.sources[wordId]).toBe('requeue')
    const insertedAt = next.wordIds.lastIndexOf(wordId)
    expect(insertedAt).toBeGreaterThan(0)
    expect(next.index).toBe(1)

    const log = (await db.reviewLogs.where('wordId').equals(wordId).toArray())[0]!
    expect(log.rating).toBe('vague')
    expect(log.longTermUpdate).toBe(true)
  }, 60_000)

  it('同日第二次评分：stateBefore 为上一次评分后的完整快照，longTermUpdate=false', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    await rateInPlan({ wordId, rating: 'vague', now: NOW + 1000 })
    const stateAfterFirst = (await db.states.get(wordId))!
    await rateInPlan({ wordId, rating: 'familiar', now: NOW + 2000 })
    const logs = await db.reviewLogs.where('wordId').equals(wordId).toArray()
    const second = logs.sort((a, b) => a.reviewedAt - b.reviewedAt)[1]!
    expect(second.longTermUpdate).toBe(false)
    expect(stableStringify(second.stateBefore)).toBe(stableStringify(stateAfterFirst))
  }, 60_000)
})

describe('撤销 / 改判（SPEC-v2 §7 / task-29）', () => {
  it('撤销首评：state 行删除、日志 corrected=true、plan index 回退', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    await rateInPlan({ wordId, rating: 'familiar', now: NOW + 1000 })
    expect(await db.states.get(wordId)).toBeTruthy()

    const undone = await undoLastRating({ wordId, now: NOW + 2000 })
    expect(undone).toBeTruthy()
    expect(await db.states.get(wordId)).toBeUndefined() // 首评 → 删除
    expect(undone!.plan.index).toBe(0)
    expect(undone!.plan.ratings[0]!.corrected).toBe(true)
    const log = (await db.reviewLogs.where('wordId').equals(wordId).toArray())[0]!
    expect(log.corrected).toBe(true)
    expect((log as typeof log & { reverted?: boolean }).reverted).toBe(true)
    // 幂等：没有未撤销记录 → null
    expect(await undoLastRating({ wordId, now: NOW + 3000 })).toBeNull()
  }, 60_000)

  it('AC5：撤销后用同一评分重提 == 从未评分（深比较一致）', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    await rateInPlan({ wordId, rating: 'familiar', now: NOW + 1000 })
    const firstState = (await db.states.get(wordId))!
    await undoLastRating({ wordId, now: NOW + 2000 })
    // AC5：同一 now 下改判结果 == 直接按新评分评一次（时间字段因此一致）
    const again = await submitRating(wordId, 'familiar', NOW + 1000, { planId: plan.id })
    expect(stableStringify(withoutTimeFields(again.state as unknown as Record<string, unknown>))).toBe(
      stableStringify(withoutTimeFields(firstState as unknown as Record<string, unknown>)),
    )
  }, 60_000)

  it('撤销会删除该次回炉插入，index 回退到该词位置', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    const originalLength = plan.wordIds.length
    await rateInPlan({ wordId, rating: 'forgot', now: NOW + 1000 })
    expect((await db.plans.get(plan.id))!.wordIds.length).toBe(originalLength + 1)
    const undone = await undoLastRating({ wordId, now: NOW + 2000 })
    expect(undone!.plan.wordIds.length).toBe(originalLength) // 回炉条目被移除
    expect(undone!.plan.index).toBe(0)
  }, 60_000)

  it('reRateInPlan：撤销+新评分，新日志 correctedBy=旧日志 id', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    await rateInPlan({ wordId, rating: 'familiar', now: NOW + 1000 })
    const firstLog = (await db.reviewLogs.where('wordId').equals(wordId).toArray())[0]!

    const result = await reRateInPlan({ wordId, rating: 'forgot', now: NOW + 2000 })
    expect(result).toBeTruthy()
    const logs = await db.reviewLogs.where('wordId').equals(wordId).toArray()
    const latest = logs.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).at(-1)!
    expect(latest.rating).toBe('forgot')
    expect(latest.correctedBy).toBe(firstLog.id)
    expect(logs.filter((log) => log.corrected === true)).toHaveLength(1)
    // 改判后 state 等于「直接按新评分评一次」
    expect(result!.state.lastRating).toBe('forgot')
  }, 60_000)

  it('撤销/改判只允许今天：跨天 → null；getLastReviewSnapshot 可返回原评分', async () => {
    await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    await rateInPlan({ wordId, rating: 'vague', now: NOW + 1000 })
    const snapshot = await getLastReviewSnapshot(wordId, NOW + 2000)
    expect(snapshot?.log.rating).toBe('vague')
    // 回炉后同 wordId 出现两次，planIndex 指向最近一次出现（撤销目标）
    expect(snapshot?.planIndex).toBeGreaterThanOrEqual(0)
    // 跨天撤销 → 拒绝
    expect(await undoLastRating({ wordId, now: NOW + DAY })).toBeNull()
  }, 60_000)

  it('统计过滤 corrected/reverted：撤销后今日已学/反馈分布不计入', async () => {
    await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const wordId = plan.wordIds[0]!
    await rateInPlan({ wordId, rating: 'familiar', now: NOW + 1000 })
    expect((await getStatsOverview(NOW + 1500)).todayReviewed).toBe(1)
    await undoLastRating({ wordId, now: NOW + 2000 })
    const overview = await getStatsOverview(NOW + 2500)
    expect(overview.todayReviewed).toBe(0)
    expect(overview.ratingCounts).toEqual({ familiar: 0, vague: 0, forgot: 0 })
  }, 60_000)
})

describe('首页事实数据 / 清理', () => {
  it('getHomeStudyData：无 plan → dueCount/newBudget；completed 后有 overdueLeft', async () => {
    const { db } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    let data = await getHomeStudyData(NOW)
    expect(data.hasDeck).toBe(true)
    expect(data.hasLearnableWord).toBe(true)
    expect(data.plan).toBeNull()
    expect(data.dueCount).toBe(0)
    expect(data.newBudget).toBe(5)

    const plan = await getTodayPlan({ now: NOW })
    await rateInPlan({ wordId: plan.wordIds[0]!, rating: 'forgot', now: NOW + 1000 })
    data = await getHomeStudyData(NOW + 2000)
    expect(data.plan?.id).toBe(plan.id)
    expect(data.todayReviewed).toBe(1)
    expect(data.remaining).toBeGreaterThan(0)
    expect(data.overdueLeft).toBe(0)

    // 完成 plan 且仍有到期复习 → overdueLeft
    await completePlan(plan.id, NOW + 3000)
    await submitRating(plan.wordIds[1]!, 'familiar', NOW + 4000) // 造一个未到期 state 不影响
    data = await getHomeStudyData(NOW + 5000)
    expect(data.plan?.completedAt).not.toBeNull()
    expect((await db.plans.get(plan.id))!.completedAt).not.toBeNull()
  }, 60_000)

  it('cleanupOldPlans：只删 keepDays 前的 plan，幂等', async () => {
    const db = getDb()
    const base = { deckId: 'd', wordIds: [], index: 0, sources: {}, goals: { dailyGoal: 1, dueCount: 0, newBudget: 1, extraCount: 0 }, ratings: [], createdAt: NOW, updatedAt: NOW, completedAt: null }
    const oldDate = localDateKey(NOW - 10 * DAY)
    const recentDate = localDateKey(NOW - 1 * DAY)
    await db.plans.put({ ...base, id: `${oldDate}:d`, date: oldDate } as DailyPlan)
    await db.plans.put({ ...base, id: `${recentDate}:d`, date: recentDate } as DailyPlan)
    expect(await cleanupOldPlans({ keepDays: 7, now: NOW })).toBe(1)
    expect(await db.plans.get(`${oldDate}:d`)).toBeUndefined()
    expect(await db.plans.get(`${recentDate}:d`)).toBeTruthy()
    expect(await cleanupOldPlans({ keepDays: 7, now: NOW })).toBe(0)
    expect(await clearPlan(`${recentDate}:d`)).toBeUndefined()
    expect(await db.plans.get(`${recentDate}:d`)).toBeUndefined()
  }, 60_000)

  it('saveTodayPlan / setPlanIndex：保存进度与移动 index', async () => {
    await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const next = await setPlanIndex(plan.id, 2)
    expect(next.index).toBe(2)
    const saved = { ...next, wordIds: next.wordIds.slice(0, 3), index: 1 }
    await saveTodayPlan(saved)
    expect((await getDb().plans.get(plan.id))!.wordIds).toHaveLength(3)
    expect((await getTodayPlan({ now: NOW })).index).toBe(1) // 续学读回保存的进度
  }, 60_000)
})

describe('迁移包 v2（含今日 plan）', () => {
  it('export → clearAllData → import(replace)：今日 plan 恢复且状态一致', async () => {
    const { deck } = await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    await rateInPlan({ wordId: plan.wordIds[0]!, rating: 'vague', now: NOW + 1000 })
    const planBefore = (await getDb().plans.get(plan.id))!

    const text = await (await exportMigration()).text()
    const file = JSON.parse(text) as { data: { plans?: DailyPlan[] }; counts: { plans?: number } }
    expect(file.data.plans).toHaveLength(1)
    expect(file.counts.plans).toBe(1)
    expect(file.data.plans![0]!.date).toBe(localDateKey(NOW))

    await clearAllData()
    expect(await getDb().plans.count()).toBe(0)
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok).toBe(true)
    const planAfter = (await getDb().plans.get(plan.id))!
    expect(planAfter.wordIds).toEqual(planBefore.wordIds)
    expect(planAfter.index).toBe(planBefore.index)
    expect(planAfter.ratings).toEqual(planBefore.ratings)
    expect((await getDb().decks.get(deck.id))?.name).toBe('计划测试词库')
  }, 120_000)

  it('非今日 plan 导入时忽略（warning）；merge 模式保留本机 plan', async () => {
    await setupDeck(10)
    await updateSettings({ 'study.dailyGoal': 5 })
    const plan = await getTodayPlan({ now: NOW })
    const text = await (await exportMigration({ includeReviewLogs: false })).text()
    const file = JSON.parse(text) as { data: { plans?: DailyPlan[] } }
    file.data.plans![0]!.date = localDateKey(NOW - 1 * DAY) // 改成昨天
    // 重算 checksum 太繁：用 force 走强制导入
    const report = await importMigration(stableStringify(file), { strategy: 'replace', force: true })
    expect(report.ok).toBe(true)
    expect(report.issues.some((issue) => issue.path === 'data.plans')).toBe(true)
    expect((await getDb().plans.get(plan.id))!.date).toBe(localDateKey(NOW)) // 本机今日 plan 未被覆盖
  }, 120_000)
})

describe('v1 → 当前版本（v3）迁移（fake-indexeddb fixture）', () => {
  it('旧 v1 库打开后数据不丢、plans/内容包表存在且为空、meta.schemaVersion=3', async () => {
    await resetDatabase()
    const DB_NAME = 'momo-reword'
    const legacy = new Dexie(DB_NAME)
    legacy.version(1).stores({
      decks: 'id, name, source, builtinKey, updatedAt',
      words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt',
      states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
      reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
      settings: 'key',
      meta: 'key',
    })
    await legacy.open()
    await legacy.table('decks').put({
      id: 'legacy-deck',
      name: '旧词库',
      source: 'custom',
      wordCount: 1,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await legacy.table('states').put({
      wordId: 'legacy-deck:apple',
      deckId: 'legacy-deck',
      phase: 'review',
      stability: 10,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      firstSeenAt: 1,
      lastReviewedAt: 1,
      dueAt: 2,
      nextIntervalDays: 3,
      retrievability: 1,
      lastRating: 'familiar',
      sameDayCount: 0,
      sameDayDate: '',
      meaningStats: {},
      sameDayRequeued: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    legacy.close()

    // 用 v2 AppDatabase 打开（getDb 内部 version(2)）
    const db = getDb()
    await db.open()
    expect(await db.decks.get('legacy-deck')).toBeTruthy()
    expect(await db.states.get('legacy-deck:apple')).toBeTruthy()
    expect(await db.plans.count()).toBe(0)
    // v3（task-69）：内容包三表自动建、空开始
    expect(await db.packs.count()).toBe(0)
    expect(await db.packItems.count()).toBe(0)
    expect(await db.contentRejects.count()).toBe(0)
    await db.writeSchemaMeta(NOW)
    expect((await db.meta.get('schemaVersion'))!.value).toBe(3)
    expect((await db.meta.get('migratedAt.v2'))!.value).toBeTruthy()
    expect((await db.meta.get('migratedAt.v3'))!.value).toBeTruthy()
    // 二次打开幂等
    db.close()
    await db.open()
    expect((await db.meta.get('schemaVersion'))!.value).toBe(3)
  }, 60_000)
})
