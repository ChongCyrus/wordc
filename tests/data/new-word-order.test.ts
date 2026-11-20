import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDeck,
  getDb,
  getSettings,
  getTodayPlan,
  getTodayQueue,
  mulberry32,
  newWordOrderKey,
  normalizeNewWordOrder,
  planSeed,
  resetDatabase,
  seededRandomFromPlan,
  settingOrDefault,
  updateDailyGoalAndResync,
  updateSettings,
  normalizeSettingValue,
} from '../../src/data'
import { localDateKey } from '../../src/core'

const NOW = new Date(2026, 11, 1, 10, 0, 0).getTime()
const DAY = 86_400_000

async function setupDeck(wordCount = 100) {
  const deck = await createDeck({
    name: '新词顺序词库',
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `nw${index}`,
      meanings: [{ pos: 'n.', cn: `词${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

beforeEach(async () => {
  await resetDatabase()
})

describe('task-47：新词顺序设置 study.newWordOrder', () => {
  it('默认 random；合法值 order/random，非法值回退 random', async () => {
    const settings = await getSettings()
    expect(settings['study.newWordOrder']).toBe('random') // 用户拍板默认随机
    expect(normalizeSettingValue('study.newWordOrder', 'order')).toBe('order')
    expect(normalizeSettingValue('study.newWordOrder', 'random')).toBe('random')
    expect(normalizeSettingValue('study.newWordOrder', 'bad')).toBeUndefined()
    expect(settingOrDefault('study.newWordOrder', 'bad')).toBe('random')
    expect(normalizeNewWordOrder('bad')).toBe('random')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(updateSettings({ 'study.newWordOrder': 'bad' } as any)).rejects.toThrow(/不合法/)
  })

  it('老库（无 study.newWordOrder 设置行）按新默认 random 生效', async () => {
    const { deck } = { deck: await setupDeck(60) }
    await updateSettings({ 'study.dailyGoal': 20 })
    // 模拟老库：删除该设置行（只剩默认值）
    await getDb().settings.delete('study.newWordOrder')
    expect(await getDb().settings.get('study.newWordOrder')).toBeUndefined()
    expect((await getSettings())['study.newWordOrder']).toBe('random')
    const plan = await getTodayPlan({ now: NOW })
    const db = getDb()
    const ordered = (
      await db.words
        .where('[deckId+order]')
        .between([deck.id, -Infinity], [deck.id, Infinity])
        .limit(20)
        .toArray()
    ).map((word) => word.id)
    expect(plan.wordIds).not.toEqual(ordered) // 老库缺失设置 → 随机而非词库序
  }, 60_000)

  it('order 模式：新词顺序 = 词库 order（前 N 个）', async () => {
    const deck = await setupDeck(60)
    await updateSettings({ 'study.newWordOrder': 'order', 'study.dailyGoal': 20 })
    const plan = await getTodayPlan({ now: NOW })
    expect(plan.goals.dailyGoal).toBe(20)
    expect(plan.wordIds).toHaveLength(20)
    const db = getDb()
    const words = await db.words
      .where('[deckId+order]')
      .between([deck.id, -Infinity], [deck.id, Infinity])
      .limit(20)
      .toArray()
    expect(plan.wordIds).toEqual(words.map((word) => word.id))
  }, 60_000)

  it('random 模式（默认）：同一 plan 退出重进/强制重建顺序一致，且与词库顺序不同', async () => {
    const deck = await setupDeck(80)
    await updateSettings({ 'study.dailyGoal': 20 })
    const plan = await getTodayPlan({ now: NOW })
    const original = plan.wordIds.slice()
    expect(original).toHaveLength(20)
    // 退出重进（读回同一 plan）
    expect((await getTodayPlan({ now: NOW + 60_000 })).wordIds).toEqual(original)
    // 强制重建（同 planId 同种子）也一致
    expect((await getTodayPlan({ now: NOW + 120_000, forceRebuild: true, dailyGoal: 20 })).wordIds).toEqual(
      original,
    )
    // 与词库顺序不同
    const db = getDb()
    const ordered = (
      await db.words
        .where('[deckId+order]')
        .between([deck.id, -Infinity], [deck.id, Infinity])
        .limit(20)
        .toArray()
    ).map((word) => word.id)
    expect(original).not.toEqual(ordered)
  }, 60_000)

  it('30 → 50：前 30 个顺序不变，追加的 20 个是同一随机序列的延续（前缀稳定）', async () => {
    await setupDeck(120)
    await updateSettings({ 'study.dailyGoal': 30 })
    const plan = await getTodayPlan({ now: NOW })
    const firstThirty = plan.wordIds.slice()
    expect(firstThirty).toHaveLength(30)

    const result = await updateDailyGoalAndResync(50, { now: NOW + 1000 })
    expect(result.added).toBe(20)
    const extended = (await getDb().plans.get(plan.id))!
    expect(extended.wordIds).toHaveLength(50)
    expect(extended.wordIds.slice(0, 30)).toEqual(firstThirty) // 前缀不变
    expect(extended.wordIds.slice(30).every((id) => !firstThirty.includes(id))).toBe(true)

    // 与「直接按 50 建队」一致（同一 shuffle 序列的前 50）
    const rebuilt = await getTodayPlan({ now: NOW + 2000, forceRebuild: true, dailyGoal: 50 })
    expect(rebuilt.wordIds).toEqual(extended.wordIds)
  }, 60_000)

  it('不同日期 → 顺序不同（种子含日期）', async () => {
    await setupDeck(80)
    await updateSettings({ 'study.dailyGoal': 20 })
    const day1 = await getTodayPlan({ now: NOW })
    const day2 = await getTodayPlan({ now: NOW + DAY })
    expect(day2.date).toBe(localDateKey(NOW + DAY))
    expect(day2.wordIds).not.toEqual(day1.wordIds)
  }, 60_000)

  it('study.repo 旧队列路径：同一天稳定、order 模式回词库顺序、注入 PRNG 可复现', async () => {
    const deck = await setupDeck(60)
    await updateSettings({ 'study.dailyGoal': 20 })
    // 默认 random：同一天两次一致
    const random1 = await getTodayQueue({ now: NOW })
    const random2 = await getTodayQueue({ now: NOW + 30_000 })
    const ids = random1.newQueue.map((state) => state.wordId)
    expect(ids).toHaveLength(20)
    expect(random2.newQueue.map((state) => state.wordId)).toEqual(ids)
    // order 模式 = 词库顺序
    await updateSettings({ 'study.newWordOrder': 'order' })
    const ordered = await getTodayQueue({ now: NOW })
    const db = getDb()
    const expected = (
      await db.words
        .where('[deckId+order]')
        .between([deck.id, -Infinity], [deck.id, Infinity])
        .limit(20)
        .toArray()
    ).map((word) => word.id)
    expect(ordered.newQueue.map((state) => state.wordId)).toEqual(expected)
    // 注入固定 PRNG：同一 random 序列可复现（Fisher-Yates）
    const seq = mulberry32(12345)
    const a = await getTodayQueue({ now: NOW, newOrder: 'random', random: mulberry32(12345) })
    const b = await getTodayQueue({ now: NOW, newOrder: 'random', random: mulberry32(12345) })
    expect(a.newQueue.map((state) => state.wordId)).toEqual(b.newQueue.map((state) => state.wordId))
    void seq
  }, 120_000)

  it('稳定种子/排序键辅助函数：同 plan 可复现、不同 plan 不同', () => {
    const planA = '2026-12-01:deck-a'
    const planB = '2026-12-02:deck-a'
    expect(planSeed(planA)).toBe(planSeed(planA))
    expect(planSeed(planA)).not.toBe(planSeed(planB))
    // 同一 planId 的 PRNG 序列可复现
    const seqA1 = seededRandomFromPlan(planA)
    const seqA2 = seededRandomFromPlan(planA)
    const values1 = Array.from({ length: 8 }, () => seqA1())
    const values2 = Array.from({ length: 8 }, () => seqA2())
    expect(values2).toEqual(values1)
    // 每词稳定键：同词同 plan 相同；不同词/不同 plan 不同
    expect(newWordOrderKey(planA, 'w1')).toBe(newWordOrderKey(planA, 'w1'))
    expect(newWordOrderKey(planA, 'w1')).not.toBe(newWordOrderKey(planA, 'w2'))
    expect(newWordOrderKey(planA, 'w1')).not.toBe(newWordOrderKey(planB, 'w1'))
  })
})
