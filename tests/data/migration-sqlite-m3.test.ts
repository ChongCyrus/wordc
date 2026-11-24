/** 0.11.0 M3：迁移 dryRun/备份/counts/幂等/失败保持 IDB/bootstrap 不 dirty */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendWordsToTodayPlan,
  buildInitialState,
  createDeck,
  getDataEpoch,
  getDb,
  getIdbCacheMeta,
  migrateIdbToSqlite,
  primeM2ReadCacheForTests,
  readLegacyIdbMigrationData,
  resetDatabase,
  setSqliteTransport,
  SQLITE_MIGRATION_STEP,
  SQLITE_SCHEMA_VERSION,
  updateSettings,
  type SqliteResponse,
} from '../../src/data'

async function seedLegacy() {
  await resetDatabase()
  const deck = await createDeck({ name: 'm3', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  await db.states.put({ ...buildInitialState(words[0]!, 1), phase: 'review' })
  await db.reviewLogs.add({
    wordId: words[0]!.id, deckId: deck.id, rating: 'familiar', reviewedAt: 2,
    stabilityBefore: 1, difficultyBefore: 5, stabilityAfter: 1, difficultyAfter: 5,
    elapsedDays: 0, nextIntervalDays: 1, retrievabilityAtReview: 0.9,
    longTermUpdate: true, corrected: false, meaningChanges: [], phaseBefore: 'review', phaseAfter: 'review',
  } as never)
  await appendWordsToTodayPlan({ wordIds: words.map((word) => word.id) })
  return { deck, words }
}

describe('0.11.0 · M3 migration', () => {
  afterEach(() => setSqliteTransport(null))

  it('dryRun 只读计数，不备份/不写 SQLite', async () => {
    await seedLegacy()
    const result = await migrateIdbToSqlite({ dryRun: true })
    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.counts.states).toBe(1)
    expect(result.counts.reviewLogs).toBe(1)
    expect(result.counts.settings).toBeGreaterThan(0)
  })

  it('真实迁移：preBackup→分批→counts→migration_state/schema_meta/epoch；幂等 skip', async () => {
    await seedLegacy()
    const legacy = await readLegacyIdbMigrationData()
    const batches: unknown[][] = []
    let backups = 0
    let txs: unknown[][] = []
    let sqliteCounts = { states: 0, plans: 0, settings: 0, reviewLogs: 0 }
    const tx = async (ops: unknown[]): Promise<SqliteResponse> => {
      txs.push(ops)
      const touchesData = ops.some((op) => ['states', 'plans', 'settings', 'review_logs'].includes((op as { table?: string }).table ?? ''))
      if (touchesData) sqliteCounts = { ...legacy.counts }
      if ((ops[0] as { table?: string })?.table !== 'migration_state' && (ops[0] as { table?: string })?.table !== 'schema_meta') batches.push(ops)
      return { ok: true }
    }
    const query = async (): Promise<SqliteResponse> => ({ ok: true, rows: [] })
    const health = async (): Promise<SqliteResponse> => ({ ok: true, data: { counts: { states: sqliteCounts.states, plans: sqliteCounts.plans, settings: sqliteCounts.settings, review_logs: sqliteCounts.reviewLogs } } })
    const beforeEpoch = await getDataEpoch()
    const result = await migrateIdbToSqlite({
      dryRun: false,
      batchSize: 2,
      preBackup: async () => { backups += 1; return { ok: true } },
      sqliteTxImpl: tx,
      sqliteQueryImpl: query,
      sqliteHealthImpl: health,
    })
    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(false)
    expect(result.counts).toEqual(legacy.counts)
    expect(backups).toBe(1)
    expect(batches.length).toBeGreaterThan(0)
    expect(txs.some((ops) => (ops[0] as { table?: string }).table === 'migration_state')).toBe(true)
    const planOp = txs.flat().find((op) => (op as { table?: string }).table === 'plans') as { row?: Record<string, unknown> } | undefined
    expect(planOp?.row).toBeTruthy()
    expect(JSON.parse(String(planOp!.row!.word_ids_json))).toHaveLength(2)
    expect(planOp!.row!.idx).toBe(0)
    expect(planOp!.row!.completed_at).toBeNull()
    expect(txs.some((ops) => ops.some((op) => (op as { table?: string }).table === 'schema_meta'))).toBe(true)
    expect(await getDataEpoch()).toBe(beforeEpoch + 1)
    expect((await getIdbCacheMeta())?.dirty).toBe(false)
    // 幂等：已 done 直接 skip，不再次备份/写
    const skip = await migrateIdbToSqlite({
      dryRun: false,
      preBackup: async () => { backups += 1; return { ok: true } },
      sqliteTxImpl: tx,
      sqliteQueryImpl: async () => ({ ok: true, rows: [{ step: SQLITE_MIGRATION_STEP, status: 'done' }] }),
      sqliteHealthImpl: health,
    })
    expect(skip.skipped).toBe(true)
    expect(skip.ok).toBe(true)
    expect(backups).toBe(1)
  })

  it('备份失败/counts 不一致：不标完成、epoch 不变', async () => {
    await seedLegacy()
    const beforeEpoch = await getDataEpoch()
    const backupFail = await migrateIdbToSqlite({
      dryRun: false,
      preBackup: async () => ({ ok: false, error: 'mock' }),
      sqliteTxImpl: async () => ({ ok: true }),
      sqliteQueryImpl: async () => ({ ok: true, rows: [] }),
      sqliteHealthImpl: async () => ({ ok: true, data: { counts: {} } }),
    }).catch((error) => ({ ok: false, error: String(error) }))
    expect(backupFail.ok).toBe(false)
    expect(await getDataEpoch()).toBe(beforeEpoch)
    const mismatch = await migrateIdbToSqlite({
      dryRun: false,
      unsafe: true,
      sqliteTxImpl: async () => ({ ok: true }),
      sqliteQueryImpl: async () => ({ ok: true, rows: [] }),
      sqliteHealthImpl: async () => ({ ok: true, data: { counts: { states: 0, plans: 0, settings: 0, review_logs: 0 } } }),
    })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.error).toMatch(/counts/)
    expect(await getDataEpoch()).toBe(beforeEpoch)
  })

  it('迁移未完成时 bootstrap 不因 SQLite counts>0 dirty 回源（cache primary）', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'm3boot', words: [{ headword: 'x', meanings: [{ cn: '义' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ ...buildInitialState(word, 1), phase: 'review' })
    await primeM2ReadCacheForTests({ generation: await getDataEpoch(), sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: true })
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') callback?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, data: { counts: { states: 1 } } }))
          else callback?.(id, JSON.stringify({ ok: true, rows: [{ step: SQLITE_MIGRATION_STEP, status: 'running' }] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const { bootstrapM2ReadCache } = await import('../../src/data')
    const result = await bootstrapM2ReadCache()
    expect(result.mode).toBe('cache')
    expect((await getIdbCacheMeta())?.dirty).toBe(false)
  })
})
