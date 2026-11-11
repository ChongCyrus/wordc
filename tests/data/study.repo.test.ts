import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { BRAND } from '../../src/app/brand'
import manifest from '../../src/data/builtin/manifest.json'

import {
  countDue,
  deleteSessionSnapshot,
  ensureBuiltinDecks,
  getDailyStats,
  getDb,
  getDeckProgress,
  getNextWords,
  getState,
  getStates,
  getStatsOverview,
  getStudyStreak,
  getTodayQueue,
  getUnfamiliarTop,
  getWordWithState,
  loadSessionSnapshot,
  recordMeaningClick,
  recordMeaningEncounters,
  resetDatabase,
  saveSessionSnapshot,
  submitRating,
  updateSettings,
} from '../../src/data'
import {
  addDays,
  firstFamiliarDays,
  firstForgetDays,
  isDue,
  localDateKey,
  startOfLocalDay,
} from '../../src/core'

const PRIMARY = BRAND.defaultDeckId
const TOTAL_BUILTIN_WORDS = manifest.decks.reduce((sum, deck) => sum + deck.wordCount, 0)
const DAY = 86_400_000
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime()

let words: Awaited<ReturnType<typeof loadFirstWords>> = []

async function loadFirstWords(limit: number) {
  const db = getDb()
  return db.words
    .where('[deckId+order]')
    .between([PRIMARY, -Infinity], [PRIMARY, Infinity])
    .limit(limit)
    .toArray()
}

beforeEach(async () => {
  await resetDatabase()
  await ensureBuiltinDecks()
  words = await loadFirstWords(5)
})

describe('每日队列（SPEC §3.8）', () => {
  it('默认从品牌默认词库取 dailyGoal=30 个新词，按 order 升序', async () => {
    await updateSettings({ 'study.newWordOrder': 'order' }) // 本用例验证词库顺序语义
    const queue = await getTodayQueue({ now: NOW })
    expect(queue.reviewQueue).toEqual([])
    expect(queue.newQueue).toHaveLength(30)
    expect(queue.dueCount).toBe(0)
    expect(queue.newBudget).toBe(30)
    expect(queue.totalPlanned).toBe(30)
    expect(queue.newQueue[0]!.wordId).toBe(`${PRIMARY}:${words[0]!.headwordLower}`)
    const orders = queue.newQueue.map((state) => state.wordId)
    expect(orders[0]).toBe(queue.newQueue[0]!.wordId)
    expect(queue.newQueue.every((state) => state.phase === 'new')).toBe(true)
  }, 120_000)

  it('复习优先：到期的已学词全部进 reviewQueue（不截断），新词配额相应减少', async () => {
    await updateSettings({ 'study.dailyGoal': 10 })
    await submitRating(words[0]!.id, 'familiar', NOW) // 首评认识：长间隔（7–90 天）
    await submitRating(words[1]!.id, 'forgot', NOW) // 首评忘记：次日
    // 同一天：都还没到期
    const sameDay = await getTodayQueue({ now: NOW })
    expect(sameDay.reviewQueue).toHaveLength(0)
    expect(sameDay.newQueue).toHaveLength(10)

    // 两天后：只有「忘记」词到期（认识词首评间隔 > 2 天，SPEC-v2 §4.1）
    const later = await getTodayQueue({ now: NOW + 2 * DAY })
    expect(later.reviewQueue.map((state) => state.wordId)).toEqual([words[1]!.id])
    expect(later.dueCount).toBe(1)
    expect(later.newBudget).toBe(9)
    expect(later.totalPlanned).toBe(10)

    // 队列不截断：到期 > dailyGoal 时 reviewQueue 仍为全量
    await updateSettings({ 'study.dailyGoal': 1 })
    const tinyGoal = await getTodayQueue({ now: NOW + 2 * DAY })
    expect(tinyGoal.reviewQueue).toHaveLength(1) // 全量到期数（1）
    expect(tinyGoal.newBudget).toBe(0)
  }, 120_000)

  it('随机新词顺序：同一天稳定、与 order 不同；两种模式都走设置', async () => {
    await updateSettings({ 'study.newWordOrder': 'order' })
    const orderQueue = await getTodayQueue({ now: NOW })
    const orderIds = orderQueue.newQueue.map((state) => state.wordId)

    await updateSettings({ 'study.newWordOrder': 'random' })
    const random1 = await getTodayQueue({ now: NOW })
    const random2 = await getTodayQueue({ now: NOW })
    const randomIds = random1.newQueue.map((state) => state.wordId)
    expect(randomIds).toHaveLength(30)
    expect(random2.newQueue.map((state) => state.wordId)).toEqual(randomIds) // 同一天稳定
    expect(randomIds).not.toEqual(orderIds) // 与词库顺序不同
    // 注入固定 PRNG 时也可复现
    const injected = await getTodayQueue({ now: NOW })
    expect(injected.newQueue.map((state) => state.wordId)).toEqual(randomIds)
  }, 120_000)

  it('手动加学词不计入 dailyGoal（extraNewWordIds）', async () => {
    await updateSettings({ 'study.dailyGoal': 5 })
    const db = getDb()
    const far = (
      await db.words
        .where('[deckId+order]')
        .between([PRIMARY, -Infinity], [PRIMARY, Infinity])
        .offset(100)
        .limit(1)
        .toArray()
    )[0]!
    const queue = await getTodayQueue({ now: NOW, extraNewWordIds: [far.id] })
    expect(queue.newQueue).toHaveLength(6)
    expect(queue.extraCount).toBe(1)
    expect(queue.newQueue[queue.newQueue.length - 1]!.wordId).toBe(far.id)
  }, 120_000)

  it('getNextWords 返回队列前 N 个词条', async () => {
    await updateSettings({ 'study.newWordOrder': 'order' })
    const list = await getNextWords({ now: NOW, limit: 3 })
    expect(list).toHaveLength(3)
    expect(list[0]!.id).toBe(words[0]!.id)
    expect(list[1]!.id).toBe(words[1]!.id)
  }, 120_000)
})

describe('评分提交（SPEC §3.4 / §3.5 / §4.8）', () => {
  it('新词首次「认识」：长间隔（按官方难度，7–90 天）+ state/log/meta 写入', async () => {
    const word = words[0]!
    const difficulty = word.difficulty ?? 5
    const expectedInterval = firstFamiliarDays(difficulty)
    const result = await submitRating(word.id, 'familiar', NOW)
    expect(result.longTermUpdate).toBe(true)
    expect(result.requeue).toBe('none')
    expect(result.state.phase).toBe('review')
    expect(result.state.firstSeenAt).toBe(NOW)
    expect(result.state.lastReviewedAt).toBe(NOW)
    expect(expectedInterval).toBeGreaterThanOrEqual(7)
    expect(expectedInterval).toBeLessThanOrEqual(90)
    expect(result.state.nextIntervalDays).toBe(expectedInterval)
    expect(result.state.dueAt).toBe(startOfLocalDay(addDays(NOW, expectedInterval)))
    expect(result.state.dueAt).not.toBe(startOfLocalDay(NOW + DAY)) // 不再统一次日
    expect(result.state.reps).toBe(1)
    expect(result.intervalDays).toBe(expectedInterval)
    expect(result.log.id).toBeGreaterThan(0)
    expect(result.log.rating).toBe('familiar')
    expect(result.log.longTermUpdate).toBe(true)
    expect(Number.isFinite(result.state.stability)).toBe(true)

    const db = getDb()
    expect(await db.states.count()).toBe(1)
    expect(await db.reviewLogs.count()).toBe(1)
    expect((await db.meta.get('lastStudyDate'))!.value).toBe(localDateKey(NOW))
  }, 120_000)

  it('新词首次「不认识」：难度 +2、间隔 1 天、requeue-forgot', async () => {
    const d = Math.min(10, Math.max(1, words[1]!.difficulty ?? 5))
    const result = await submitRating(words[1]!.id, 'forgot', NOW)
    expect(result.state.difficulty).toBe(Math.min(18, d + 2))
    expect(result.state.nextIntervalDays).toBe(firstForgetDays())
    expect(result.requeue).toBe('requeue-forgot')
    expect(result.state.phase).toBe('learning')
    expect(result.state.lapses).toBe(1)
  }, 120_000)

  it('新词首次「模糊」：不出现 NaN/Infinity，requeue-vague', async () => {
    const d = Math.min(10, Math.max(1, words[2]!.difficulty ?? 5))
    const result = await submitRating(words[2]!.id, 'vague', NOW)
    expect(result.requeue).toBe('requeue-vague')
    expect(Number.isFinite(result.state.stability)).toBe(true)
    expect(Number.isFinite(result.state.difficulty)).toBe(true)
    expect(result.state.difficulty).toBe(d) // 模糊不升难度
    expect(result.state.nextIntervalDays).toBeGreaterThanOrEqual(1)
    expect(result.state.nextIntervalDays).toBeLessThanOrEqual(7)
    expect(result.state.phase).toBe('learning')
  }, 120_000)

  it('同日第二次反馈：longTermUpdate=false，h/d/dueAt 不变', async () => {
    const first = await submitRating(words[0]!.id, 'familiar', NOW)
    const second = await submitRating(words[0]!.id, 'vague', NOW + 60_000)
    expect(second.longTermUpdate).toBe(false)
    // 当日非首次反馈不改长期状态，但仍按评分触发当日回炉（官方 help30 / DECISIONS D9 修订）
    expect(second.requeue).toBe('requeue-vague')
    expect(second.state.stability).toBe(first.state.stability)
    expect(second.state.difficulty).toBe(first.state.difficulty)
    expect(second.state.dueAt).toBe(first.state.dueAt)
    expect(second.state.sameDayCount).toBe(2)
    expect(second.state.lastRating).toBe('vague')
    expect(second.log.longTermUpdate).toBe(false)
    expect(await getDb().reviewLogs.count()).toBe(2)
  }, 120_000)

  it('跨天再评：长期状态继续更新，间隔变大', async () => {
    const first = await submitRating(words[0]!.id, 'familiar', NOW)
    const laterAt = NOW + 2 * DAY
    const second = await submitRating(words[0]!.id, 'familiar', laterAt)
    expect(second.longTermUpdate).toBe(true)
    expect(second.state.stability).toBeGreaterThan(first.state.stability)
    expect(second.state.nextIntervalDays).toBeGreaterThan(1)
    expect(second.state.dueAt).toBeGreaterThan(first.state.dueAt!)
    expect(second.state.reps).toBe(2)
  }, 120_000)

  it('不存在的词条 → throw', async () => {
    await expect(submitRating('no-such-word', 'familiar', NOW)).rejects.toThrow(/词条不存在/)
  }, 120_000)
})

describe('不熟悉度（AC2 / SPEC §4.6）', () => {
  it('进入注释面 encounters+1（全部含义），点击 clicks+1', async () => {
    const word = words[0]!
    const meaningIds = word.meanings.map((meaning) => meaning.id)
    const state = await recordMeaningEncounters(word.id, meaningIds)
    expect(state.phase).toBe('new')
    for (const id of meaningIds) {
      expect(state.meaningStats[id]).toEqual({ clicks: 0, encounters: 1 })
    }
    const clicked = await recordMeaningClick(word.id, meaningIds[0]!)
    expect(clicked.meaningStats[meaningIds[0]!]).toEqual({ clicks: 1, encounters: 1 })
    const clickedTwice = await recordMeaningClick(word.id, meaningIds[0]!)
    expect(clickedTwice.meaningStats[meaningIds[0]!]).toEqual({ clicks: 2, encounters: 1 })

    // 持久化
    const reloaded = await getState(word.id)
    expect(reloaded!.meaningStats[meaningIds[0]!]!.clicks).toBe(2)
  }, 120_000)

  it('getUnfamiliarTop 带词条/释义文本', async () => {
    const word = words[0]!
    await recordMeaningEncounters(word.id, word.meanings.map((meaning) => meaning.id))
    await recordMeaningClick(word.id, word.meanings[0]!.id)
    const top = await getUnfamiliarTop(5)
    expect(top.length).toBeGreaterThan(0)
    expect(top[0]!.wordId).toBe(word.id)
    expect(top[0]!.headword).toBe(word.headword)
    expect(top[0]!.cn).toBe(word.meanings[0]!.cn)
    expect(top[0]!.familiarity).toBe(1)
  }, 120_000)
})

describe('会话快照（D15）', () => {
  it('保存 / 读取 / 删除', async () => {
    const word = words[0]!
    const snapshot = {
      wordId: word.id,
      deckId: word.deckId,
      wcCounts: { [word.meanings[0]!.id]: 2 },
      wcActiveMeaningId: word.meanings[0]!.id,
      stage: 'memory' as const,
      startedAt: NOW,
      updatedAt: NOW,
    }
    await saveSessionSnapshot(snapshot)
    const loaded = await loadSessionSnapshot(word.id)
    expect(loaded?.wcCounts).toEqual(snapshot.wcCounts)
    expect(loaded?.stage).toBe('memory')
    expect(await loadSessionSnapshot('missing')).toBeNull()
    await deleteSessionSnapshot(word.id)
    expect(await loadSessionSnapshot(word.id)).toBeNull()
  }, 120_000)
})

describe('状态查询 / 统计（SPEC §3.10）', () => {
  it('getWordWithState / getStates 批量', async () => {
    const pair = await getWordWithState(words[0]!.id)
    expect(pair?.word.headword).toBe(words[0]!.headword)
    expect(pair?.state).toBeNull()
    await submitRating(words[0]!.id, 'familiar', NOW)
    const after = await getWordWithState(words[0]!.id)
    expect(after?.state?.phase).toBe('review')
    expect(await getWordWithState('missing')).toBeNull()

    await submitRating(words[1]!.id, 'vague', NOW)
    const states = await getStates([words[0]!.id, words[1]!.id, 'missing'])
    expect(states).toHaveLength(2)
    expect(await getStates()).toHaveLength(2)
  }, 120_000)

  it('getStatsOverview / getDailyStats / getStudyStreak / countDue', async () => {
    await submitRating(words[0]!.id, 'familiar', NOW)
    await submitRating(words[1]!.id, 'vague', NOW + 1000)
    await submitRating(words[2]!.id, 'forgot', NOW + 2000)
    // 同日重复反馈不计入「今日已学」
    await submitRating(words[0]!.id, 'forgot', NOW + 3000)

    const overview = await getStatsOverview(NOW + 4000)
    expect(overview.todayReviewed).toBe(3)
    expect(overview.todayNewLearned).toBe(3)
    expect(overview.totalLearned).toBe(3)
    expect(overview.ratingCounts).toEqual({ familiar: 1, vague: 1, forgot: 1 })
    expect(overview.streakDays).toBe(1)
    expect(overview.dailyGoal).toBe(30)
    expect(overview.totalWords).toBe(TOTAL_BUILTIN_WORDS)

    expect(await getStudyStreak(NOW + 4000)).toBe(1)

    const daily = await getDailyStats(7, NOW + 4000)
    expect(daily).toHaveLength(7)
    const today = daily[daily.length - 1]!
    expect(today.date).toBe(localDateKey(NOW))
    expect(today.reviewed).toBe(3)
    expect(today.learned).toBe(3)

    expect(await countDue(PRIMARY, NOW + 4000)).toBe(0)
    // 用 core 的 isDue 现算期望（首评间隔因官方难度而不同，不写死天数）
    const expectedDue = (await getStates()).filter((state) => isDue(state, NOW + 2 * DAY)).length
    expect(await countDue(PRIMARY, NOW + 2 * DAY)).toBe(expectedDue)
    const progress = await getDeckProgress(PRIMARY, NOW)
    expect(progress.studiedCount).toBe(3)
  }, 120_000)
})
