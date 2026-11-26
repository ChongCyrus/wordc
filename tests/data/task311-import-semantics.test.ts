/**
 * task-311（审计 B P0-1 / P1-1 / P1-2）：
 * - replace 真替换：states 按 deck 差集删除、plans 先清后写，导入后精确对齐；
 * - merge 保留本机今日 plan（不再被 staging 兜底覆盖）；
 * - staging 失败时 import:last 必须被覆写为失败，且 diag 记录三源计数。
 */
import '../data/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInitialState,
  createDeck,
  exportMigrationText,
  getDb,
  getLastImportReport,
  getLearningWriteSource,
  importMigration,
  localDateKey,
  persistLearningWriteSource,
  planIdOf,
  resetDatabase,
  setSqliteTransport,
  updateSettings,
} from '../../src/data'
import { computeChecksum, migrationChecksumPayload } from '../../src/data/checksum'
import { installMemorySqlite } from './helpers/sqlite-memory'

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb')
})

async function seedDeck(name: string, headwords: string[]) {
  const deck = await createDeck({ name, words: headwords.map((headword) => ({ headword, meanings: [{ cn: headword }] })) })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  for (const word of words) await db.states.put({ ...buildInitialState(word, 100), phase: 'review' } as never)
  return { deck, words }
}

/** 改写包内 data 并重算 checksum（模拟“包内没有这些 state/plan”的旧备份） */
async function patchFile(raw: string, mutate: (file: Record<string, unknown>) => void): Promise<string> {
  const file = JSON.parse(raw) as Record<string, unknown> & { data: Record<string, unknown> }
  mutate(file)
  const checksum = await computeChecksum(
    migrationChecksumPayload({
      format: String(file.format ?? ''),
      formatVersion: Number(file.formatVersion ?? 0),
      dataVersion: Number(file.dataVersion ?? 0),
      data: file.data,
    }),
  )
  return JSON.stringify({ ...file, checksum: checksum.hex })
}

function stagingImpl(mock: ReturnType<typeof installMemorySqlite>) {
  return {
    createBackup: (async () => ({
      ok: true,
      manifest: {
        format: 'momo-sqlite-backup-manifest',
        formatVersion: 1,
        name: 'pre.db',
        path: '/p/pre.db',
        bytes: 4096,
        createdAt: 1,
        userVersion: 3,
        dataEpoch: 0,
        counts: { states: 0, plans: 0, settings: 0, reviewLogs: 0 },
        integrityOk: true,
      },
    })) as never,
    restoreBackup: ((input: { path?: string; manifest?: { path?: string } }, o: { skipWriteLock?: boolean }) => {
      const path = input.path ?? input.manifest?.path ?? ''
      return import('../../src/data/sqlite-backup').then(({ restoreSqliteFactsBackup }) =>
        restoreSqliteFactsBackup({ path }, { preBackup: async () => ({ ok: true }), skipWriteLock: o.skipWriteLock === true }),
      )
    }) as never,
    migrate: (async () => {
      const db = getDb()
      const [states, plans, settings, logs] = await Promise.all([
        db.states.toArray(),
        db.plans.toArray(),
        db.settings.toArray(),
        db.reviewLogs.toArray(),
      ])
      const { migrateIdbToSqlite } = await import('../../src/data/migration-sqlite')
      const result = await migrateIdbToSqlite({ dryRun: false, unsafe: true, skipWriteLock: true, force: true, sqliteTxImpl: (ops) => import('../../src/data/native-sqlite').then(({ sqliteTx }) => sqliteTx(ops)) })
      if (!result.ok) return result
      void states; void plans; void settings; void logs
      return result
    }) as never,
    health: async () => {
      const db = getDb()
      return {
        ok: true,
        counts: {
          states: await db.states.count(),
          plans: await db.plans.count(),
          settings: await db.settings.count(),
          review_logs: await db.reviewLogs.count(),
        },
      }
    },
    _mock: mock,
  }
}

describe('task-311 P0-1 · replace 真替换', () => {
  it('states 按 deck 差集删除、plans 先清后写：导入后与包内精确相等', async () => {
    await resetDatabase()
    const { deck, words } = await seedDeck('p0-1-deck', ['alpha', 'beta'])
    const db = getDb()
    const today = localDateKey(Date.now())
    const localPlanId = planIdOf(today, deck.id)
    await db.plans.put({
      id: localPlanId,
      date: today,
      deckId: deck.id,
      wordIds: [words[0]!.id, words[1]!.id],
      index: 2,
      sources: {},
      goals: { dailyGoal: 2, dueCount: 2, newBudget: 0, extraCount: 0 },
      ratings: [],
      createdAt: 100,
      updatedAt: 100,
      completedAt: null,
    } as never)

    // 备份：只保留 alpha 的 state，且不带 plan（模拟旧包/部分包）
    const raw = await exportMigrationText()
    const patched = await patchFile(raw, (file) => {
      const data = file.data as { states: Array<{ wordId: string }>; plans?: unknown }
      data.states = data.states.filter((state) => state.wordId === words[0]!.id)
      delete data.plans
    })

    await persistLearningWriteSource('sqlite')
    const mock = installMemorySqlite()
    mock.setRows('states', [])
    mock.setRows('plans', [])
    mock.setRows('settings', [])
    mock.setRows('review_logs', [])
    const report = await importMigration(patched, {
      strategy: 'replace',
      preBackup: async () => ({ ok: true }),
      sqliteStageImpl: stagingImpl(mock) as never,
    })
    expect(report.ok).toBe(true)

    const stateWordIds = (await db.states.where('deckId').equals(deck.id).primaryKeys()) as string[]
    expect(stateWordIds).toEqual([words[0]!.id])
    expect(await db.plans.count()).toBe(0)
    expect(mock.rows('states').length).toBe(1)
    expect(mock.rows('plans').length).toBe(0)
  }, 60_000)

  it('包内带今日 plan 时 replace 精确恢复 1 条（清掉本机旧 plan）', async () => {
    await resetDatabase()
    const { deck, words } = await seedDeck('p0-1-plan', ['gamma'])
    const db = getDb()
    const today = localDateKey(Date.now())
    await db.plans.put({
      id: planIdOf(today, deck.id),
      date: today,
      deckId: deck.id,
      wordIds: [words[0]!.id],
      index: 1,
      sources: {},
      goals: { dailyGoal: 1, dueCount: 1, newBudget: 0, extraCount: 0 },
      ratings: [],
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
    } as never)
    const raw = await exportMigrationText()
    const filePlan = (JSON.parse(raw) as { data: { plans: Array<{ index: number }> } }).data.plans[0]!
    // 本机在导出后继续学习：index 变化，模拟“本机旧 plan”
    await db.plans.put({ ...(await db.plans.get(planIdOf(today, deck.id)))!, index: 0, updatedAt: 2 } as never)

    await persistLearningWriteSource('sqlite')
    const mock = installMemorySqlite()
    mock.setRows('states', [])
    mock.setRows('plans', [])
    mock.setRows('settings', [])
    mock.setRows('review_logs', [])
    const report = await importMigration(raw, {
      strategy: 'replace',
      preBackup: async () => ({ ok: true }),
      sqliteStageImpl: stagingImpl(mock) as never,
    })
    expect(report.ok).toBe(true)
    const plans = await db.plans.toArray()
    expect(plans).toHaveLength(1)
    expect(plans[0]!.index).toBe(filePlan.index)
    expect(mock.rows('plans')).toHaveLength(1)
  }, 60_000)
})

describe('task-311 P1-1 · merge 保留本机今日 plan', () => {
  it('merge 不覆盖本机 plan，并给出“未导入包内计划”警告', async () => {
    await resetDatabase()
    const { deck, words } = await seedDeck('p1-1-deck', ['delta'])
    const db = getDb()
    const today = localDateKey(Date.now())
    await db.plans.put({
      id: planIdOf(today, deck.id),
      date: today,
      deckId: deck.id,
      wordIds: [words[0]!.id],
      index: 1,
      sources: {},
      goals: { dailyGoal: 1, dueCount: 1, newBudget: 0, extraCount: 0 },
      ratings: [],
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
    } as never)
    const raw = await exportMigrationText()
    // 本机导入前把 index 改成 0（包内是 1）；merge 必须保留 0
    await db.plans.put({ ...(await db.plans.get(planIdOf(today, deck.id)))!, index: 0, updatedAt: 5 } as never)

    await persistLearningWriteSource('sqlite')
    const mock = installMemorySqlite()
    mock.setRows('states', [])
    mock.setRows('plans', [])
    mock.setRows('settings', [])
    mock.setRows('review_logs', [])
    const report = await importMigration(raw, {
      strategy: 'merge',
      preBackup: async () => ({ ok: true }),
      sqliteStageImpl: stagingImpl(mock) as never,
    })
    expect(report.ok).toBe(true)
    const plan = await db.plans.get(planIdOf(today, deck.id))
    expect(plan?.index).toBe(0)
    expect(report.issues.some((issue) => /未导入包内今日计划/.test(issue.message))).toBe(true)
  }, 60_000)
})

describe('task-311 P1-2 · staging 失败必须覆盖 import:last', () => {
  it('counts 校验失败时 import:last 为失败并写三源 diag', async () => {
    await resetDatabase()
    await seedDeck('p1-2-deck', ['epsilon'])
    const raw = await exportMigrationText()
    await persistLearningWriteSource('sqlite')
    const mock = installMemorySqlite()
    mock.setRows('states', [])
    mock.setRows('plans', [])
    mock.setRows('settings', [])
    mock.setRows('review_logs', [])

    const failing = {
      ...stagingImpl(mock),
      // 模拟 SQLite/IDB counts 不一致（导入后校验失败）
      health: async () => ({ ok: true, counts: { states: 999, plans: 0, settings: 0, review_logs: 0 } }),
    }
    await expect(
      importMigration(raw, {
        strategy: 'replace',
        preBackup: async () => ({ ok: true }),
        sqliteStageImpl: failing as never,
      }),
    ).rejects.toThrow(/counts 不一致/)

    const last = await getLastImportReport()
    expect(last?.ok).toBe(false)
    expect(last?.issues.some((issue) => issue.level === 'error')).toBe(true)

    const diag = (await getDb().meta.get('import.sqlite.stageDiag'))?.value as
      | { sources?: { idb?: unknown; content?: unknown } }
      | undefined
    expect(diag?.sources?.idb).toBeTruthy()
    expect(diag?.sources?.content).toBeTruthy()
  }, 60_000)
})

describe('task-311 P0-2 · settings 包外键不再导致导入失败', () => {
  it('设备 SQLite 多出包外 settings 键 → 收敛后 replace 成功且键集合一致', async () => {
    await resetDatabase()
    await seedDeck('p0-2-deck', ['zeta'])
    const raw = await exportMigrationText()
    await persistLearningWriteSource('sqlite')
    const mock = installMemorySqlite()
    mock.setRows('states', [])
    mock.setRows('plans', [])
    mock.setRows('review_logs', [])
    // 设备侧旧键：包内没有、IDB 也没有（旧版本包/换机场景）
    mock.setRows('settings', [
      { key: 'data.selectedDeckId', value_json: '"p0-2-deck"', updated_at: 1 },
      { key: 'study.newWordSource', value_json: '"manual"', updated_at: 1 },
      { key: 'data.maimemoToken', value_json: '"secret"', updated_at: 1 },
    ])

    const report = await importMigration(raw, {
      strategy: 'replace',
      preBackup: async () => ({ ok: true }),
      sqliteStageImpl: stagingImpl(mock) as never,
    })
    expect(report.ok).toBe(true)
    const sqliteKeys = mock
      .rows('settings')
      .map((row) => String(row.key))
      .sort()
    const idbKeys = (await getDb().settings.toArray()).map((row) => String(row.key)).sort()
    // 包外键被收敛删除；设备本地白名单（token）保留；SQLite 与 IDB 键集合一致
    expect(sqliteKeys).toEqual(idbKeys)
    expect(sqliteKeys).toContain('data.maimemoToken')
    expect(sqliteKeys).not.toContain('study.newWordSource')
  }, 60_000)
})

describe('task-311 P0-3 · 失败时收敛 content 写源', () => {
  it('staging 失败后 content 写源与 learning 写源一致，且清理 contentMigrationState', async () => {
    await resetDatabase()
    await seedDeck('p0-3-deck', ['eta'])
    const raw = await exportMigrationText()
    await persistLearningWriteSource('sqlite')
    const db = getDb()
    // 模拟导入前存在半迁移状态
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'running', at: Date.now() }, updatedAt: Date.now() })
    const mock = installMemorySqlite()
    mock.setRows('states', [])
    mock.setRows('plans', [])
    mock.setRows('settings', [])
    mock.setRows('review_logs', [])

    const failing = {
      ...stagingImpl(mock),
      health: async () => ({ ok: true, counts: { states: 999, plans: 0, settings: 0, review_logs: 0 } }),
    }
    await expect(
      importMigration(raw, { strategy: 'replace', preBackup: async () => ({ ok: true }), sqliteStageImpl: failing as never }),
    ).rejects.toThrow(/counts 不一致/)

    const { getContentWriteSource } = await import('../../src/data/content-write-source')
    expect(await getContentWriteSource()).toBe('idb')
    expect(getLearningWriteSource()).toBe('idb')
    expect(await db.meta.get('contentMigrationState')).toBeUndefined()

    const diag = (await db.meta.get('import.sqlite.stageDiag'))?.value as
      | { contentSourceBefore?: string; contentConverge?: { ok: boolean; source?: string }; sources?: { content?: unknown } }
      | undefined
    expect(diag?.contentSourceBefore).toBe('idb')
    expect(diag?.contentConverge?.ok).toBe(true)
    expect(diag?.sources?.content).toBeTruthy()
  }, 60_000)
})
