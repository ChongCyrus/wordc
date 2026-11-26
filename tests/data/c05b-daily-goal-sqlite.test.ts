/**
 * task-314 C-05b 专项：sqlite 写源下改「每日学习量」必须写进 SQLite 事实源，
 * 重启（cache 重建 / 重新读 SQLite）后 plan 的 index/wordIds 仍一致，不回退。
 *
 * 背景（audit-0.16-writesource.md C-05b）：`updateDailyGoalAndResync` 曾只写 IDB，
 * 导致重启/rebuild 后今日队列回退，刚追加的新词消失。修复见 `e28d5f2`（plans.repo.ts:1037）。
 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeck,
  getDb,
  getTodayPlan,
  localDateKey,
  persistLearningWriteSource,
  rateInPlan,
  recomputePlanForGoal,
  primeM2ReadCacheForTests,
  resetDatabase,
  setSqliteTransport,
  SQLITE_SCHEMA_VERSION,
  updateDailyGoalAndResync,
  updateSettings,
} from '../../src/data'
import { installMemorySqlite, type MemorySqlite } from './helpers/sqlite-memory'
import { readPlanFromSqliteRaw } from '../../src/data/sqlite-read'

const NOW = new Date(2026, 10, 11, 10, 0, 0).getTime()

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb')
})

/**
 * 把 IDB 当前全部事实（states/plans/settings/reviewLogs）压进内存 SQLite，
 * 等价于生产上“已在 sqlite 写源的设备”。用真实 migrateIdbToSqlite，避免手工造行口径漂移。
 */
async function pushIdbFactsToSqlite(): Promise<void> {
  const { migrateIdbToSqlite } = await import('../../src/data/migration-sqlite')
  const migrated = await migrateIdbToSqlite({ dryRun: false, unsafe: true, skipWriteLock: true })
  if (!migrated.ok) throw new Error(`seed migrate failed: ${migrated.error ?? 'unknown'}`)
}

async function readSqlitePlan(mock: MemorySqlite): Promise<{ idx: number; wordIds: string[] } | null> {
  const row = mock.rows('plans')[0] as Record<string, unknown> | undefined
  if (!row) return null
  return { idx: Number(row.idx ?? 0), wordIds: JSON.parse(String(row.word_ids_json ?? '[]')) as string[] }
}

/**
 * C-04 后 settings/plan 读路径在 IDB cache meta 缺失时 fail-closed 回源 SQLite；
 * 这些用例要模拟“运行中的 sqlite 设备”，必须同时置 cache meta ready，否则读不到本机设置。
 */
async function switchToSqliteWriteSource(): Promise<void> {
  await persistLearningWriteSource('sqlite')
  await primeM2ReadCacheForTests({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false })
  // 生产上 sqlite 写源下 settings 也走 SQLite；测试需同步设置写模式，否则 updateDailyGoalAndResync
  // 写的 study.dailyGoal 只落 IDB，rebuild 会正确报“setting 分叉”（那是测试造的数据，不是被测缺陷）。
  const { persistSettingsWriteMode } = await import('../../src/data/settings.repo')
  await persistSettingsWriteMode('sqlite')
}

async function setup(wordCount = 60): Promise<{ deckId: string; planId: string }> {
  await resetDatabase()
  const deck = await createDeck({
    name: 'c05b-deck',
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `c05b${index}`,
      meanings: [{ pos: 'n.', cn: `词${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id, 'study.dailyGoal': 20, 'study.newWordSource': 'auto' })
  const plan = await getTodayPlan({ now: NOW })
  return { deckId: deck.id, planId: plan.id }
}

describe('C-05b：sqlite 写源下改每日学习量 → SQLite 事实源同步', () => {
  it('增大 20→40：SQLite idx/wordIds 与新 IDB 一致，重启（cache 重建）后不回退', async () => {
    const { deckId, planId } = await setup()
    const db = getDb()
    const before = (await db.plans.get(planId))!
    expect(before.wordIds).toHaveLength(20)

    const mock = installMemorySqlite()
    await pushIdbFactsToSqlite()
    await switchToSqliteWriteSource()

    const result = await updateDailyGoalAndResync(40, { now: NOW + 1000 })
    expect(result.plan).toBeTruthy()
    expect(result.added).toBe(20)
    expect(result.plan!.wordIds).toHaveLength(40)

    // 1) SQLite 事实源已写入（不是只写 IDB）
    const sqlitePlan = await readSqlitePlan(mock)
    expect(sqlitePlan).toBeTruthy()
    expect(sqlitePlan!.wordIds).toHaveLength(40)
    expect(sqlitePlan!.wordIds).toEqual(result.plan!.wordIds)
    expect(sqlitePlan!.idx).toBe(result.plan!.index)

    // 2) 模拟重启：清掉 IDB plan cache，直接从 SQLite 事实源读（重启后 UI 走的就是这条路径）
    await db.plans.clear()
    expect(await db.plans.get(planId)).toBeUndefined()
    const afterRestart = await readPlanFromSqliteRaw(planId)
    expect(afterRestart).toBeTruthy()
    expect(afterRestart!.wordIds).toEqual(result.plan!.wordIds)
    expect(afterRestart!.index).toBe(result.plan!.index)
    expect(afterRestart!.wordIds).toHaveLength(40)
    expect(afterRestart!.goals.dailyGoal).toBe(40)
    expect(afterRestart!.deckId).toBe(deckId)
    expect(afterRestart!.date).toBe(localDateKey(NOW))
  }, 60_000)

  it('减小 40→10：SQLite 同步裁剪；已评分词不被移除，重启后仍一致', async () => {
    const { planId } = await setup()
    const db = getDb()
    const before = (await db.plans.get(planId))!
    expect(before.wordIds).toHaveLength(20)

    const mock = installMemorySqlite()
    await pushIdbFactsToSqlite()
    await switchToSqliteWriteSource()

    // 先加大到 40，再评掉前 2 个（已评分不可被“减小”移除）
    const grown = await updateDailyGoalAndResync(40, { now: NOW + 1000 })
    expect(grown.plan).toBeTruthy()
    for (const wordId of grown.plan!.wordIds.slice(0, 2)) {
      await rateInPlan({ wordId, rating: 'familiar', now: NOW + 2000 })
    }
    const shrunk = await updateDailyGoalAndResync(10, { now: NOW + 3000 })
    expect(shrunk.plan).toBeTruthy()
    expect(shrunk.removed).toBeGreaterThan(0)

    const sqlitePlan = await readSqlitePlan(mock)
    expect(sqlitePlan!.wordIds.length).toBe(shrunk.plan!.wordIds.length)
    expect(sqlitePlan!.idx).toBe(shrunk.plan!.index)

    await db.plans.clear()
    const afterRestart = await readPlanFromSqliteRaw(planId)
    expect(afterRestart!.wordIds).toEqual(shrunk.plan!.wordIds)
    expect(afterRestart!.index).toBe(shrunk.plan!.index)
    expect(afterRestart!.goals.dailyGoal).toBe(10)
  }, 60_000)

  it('目标不变（幂等）：不写库，SQLite 保持原值', async () => {
    const { planId } = await setup()
    const db = getDb()
    const before = (await db.plans.get(planId))!
    const mock = installMemorySqlite()
    await pushIdbFactsToSqlite()
    await switchToSqliteWriteSource()
    // 注：幂等分支仍会调用一次 savePlanSqlite（写回同样内容，非数据问题），只断言内容未变。
    const result = await updateDailyGoalAndResync(20, { now: NOW + 1000 })
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
    const sqlitePlan = await readSqlitePlan(mock)
    expect(sqlitePlan!.wordIds).toEqual(before.wordIds)
    expect(sqlitePlan!.idx).toBe(before.index)
  }, 60_000)
})

describe('C-05b 边界：recomputePlanForGoal 只写 IDB 时，updateDailyGoalAndResync 必须补写 SQLite', () => {
  it('直接调用 recomputePlanForGoal（只写 IDB）后，函数返回的 plan 与随后 SQLite 写入口径一致', async () => {
    const { planId } = await setup()
    const db = getDb()
    const mock = installMemorySqlite()
    await pushIdbFactsToSqlite()
    await switchToSqliteWriteSource()

    // recomputePlanForGoal 自身只写 IDB（历史实现），updateDailyGoalAndResync 负责补 SQLite
    const recomputed = await recomputePlanForGoal({ planId, newGoal: 30, now: NOW + 1000 })
    expect(recomputed.plan.wordIds).toHaveLength(30)
    const idbAfter = (await db.plans.get(planId))!
    expect(idbAfter.wordIds).toEqual(recomputed.plan.wordIds)

    const result = await updateDailyGoalAndResync(30, { now: NOW + 2000 })
    expect(result.plan).toBeTruthy()
    const sqlitePlan = await readSqlitePlan(mock)
    expect(sqlitePlan!.wordIds).toEqual(result.plan!.wordIds)
    expect(sqlitePlan!.idx).toBe(result.plan!.index)
  }, 60_000)
})
