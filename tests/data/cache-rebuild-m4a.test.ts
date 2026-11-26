/** 0.11.0 M4a：IDB 增量 delta → SQLite；重建 cache 不丢新评分；冲突拒绝 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInitialState,
  createDeck,
  getDb,
  rebuildIdbCacheFromSqlite,
  resetDatabase,
  setSqliteTransport,
  SQLITE_SCHEMA_VERSION,
  updateSettings,
} from '../../src/data'

function stateRow(state: Record<string, unknown> | any) {
  return {
    word_id: state.wordId, deck_id: state.deckId, phase: state.phase,
    stability: state.stability, difficulty: state.difficulty, reps: state.reps, lapses: state.lapses,
    first_seen_at: state.firstSeenAt, last_reviewed_at: state.lastReviewedAt, due_at: state.dueAt,
    next_interval_days: state.nextIntervalDays, retrievability: state.retrievability,
    last_rating: state.lastRating, same_day_count: state.sameDayCount, same_day_date: state.sameDayDate,
    today_progress: state.todayProgress ?? null, today_progress_level: state.todayProgressLevel ?? null,
    can_finish_today: state.canFinishToday == null ? null : state.canFinishToday ? 1 : 0,
    meaning_stats_json: JSON.stringify(state.meaningStats ?? {}),
    core_sense_stats_json: state.coreSenseStats ? JSON.stringify(state.coreSenseStats) : null,
    part_stats_json: state.partStats ? JSON.stringify(state.partStats) : null,
    same_day_requeued: state.sameDayRequeued,
    imported_from: state.importedFrom ?? null, imported_at: state.importedAt ?? null,
    created_at: state.createdAt, updated_at: state.updatedAt,
  }
}

async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'm4a', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  for (const word of words) await db.states.put({ ...buildInitialState(word, 100), phase: 'review' })
  return { deck, words }
}

function install(sqliteStates: Array<Record<string, unknown>>, healthCounts: () => Record<string, number>, sqliteSettings: Array<Record<string, unknown>> = []) {
  let seq = 0
  const statePages = { count: 0 }
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string; offset?: number; limit?: number } }
      const requestId = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') {
          callback?.(requestId, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, data: { counts: healthCounts() } }))
          return
        }
        const table = req.payload?.table
        if (table === 'states') statePages.count += 1
        const all = table === 'states' ? sqliteStates : table === 'settings' ? sqliteSettings : []
        const offset = Number(req.payload?.offset ?? 0)
        const limit = Number(req.payload?.limit ?? all.length)
        callback?.(requestId, JSON.stringify({ ok: true, rows: all.slice(offset, offset + limit), nextCursor: null }))
      }, 0)
      return JSON.stringify({ requestId })
    },
  })
  return { statePages }
}

afterEach(() => setSqliteTransport(null))

describe('0.11.0 · M4a cache rebuild/delta', () => {
  it('IDB 新评分 → 分叉拒绝反向覆盖 SQLite；IDB/SQLite 不变', async () => {
    const { words } = await seed()
    const db = getDb()
    const both = await db.states.toArray()
    const sqliteStates: Array<Record<string, unknown>> = both.map(stateRow)
    // 模拟 M3 后用户在 IDB 新评分：alpha updatedAt 更新 + reps 增加
    await db.states.put({ ...both[0]!, reps: both[0]!.reps + 1, updatedAt: 999, phase: 'learning' })
    let sqliteCounts = { states: 2, plans: 0, settings: 1, reviewLogs: 0 }
    const settingRows = (await db.settings.toArray()).map((row) => ({ key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt }))
    install(sqliteStates, () => sqliteCounts, settingRows)
    const result = await rebuildIdbCacheFromSqlite({
      dryRun: false,
      unsafe: true,
      sqliteTxImpl: async (ops) => {
        for (const op of ops) {
          const row = (op as { row?: Record<string, unknown> }).row
          if (row?.word_id) {
            const index = sqliteStates.findIndex((state) => state.word_id === row.word_id)
            if (index >= 0) sqliteStates[index] = row
            else sqliteStates.push(row)
          }
        }
        sqliteCounts = { states: sqliteStates.length, plans: 0, settings: 1, reviewLogs: 0 }
        return { ok: true }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.conflict).toMatch(/分叉|反向覆盖/)
    expect(sqliteCounts.states).toBe(2)
    const restored = await db.states.get(words[0]!.id)
    expect(restored?.updatedAt).toBe(999)
    expect(restored?.phase).toBe('learning')
  })

  it('同 updatedAt 但字段冲突 → 拒绝，不动 IDB/SQLite', async () => {
    const { words } = await seed()
    const db = getDb()
    const states = await db.states.toArray()
    const sqliteStates = states.map(stateRow)
    await db.states.put({ ...states[0]!, reps: states[0]!.reps + 5 })
    let txCalls = 0
    const settingRows = (await db.settings.toArray()).map((row) => ({ key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt }))
    install(sqliteStates, () => ({ states: 2, plans: 0, settings: 1, reviewLogs: 0 }), settingRows)
    const result = await rebuildIdbCacheFromSqlite({
      dryRun: false,
      unsafe: true,
      sqliteTxImpl: async () => { txCalls += 1; return { ok: true } },
    })
    expect(result.ok).toBe(false)
    expect(result.conflict).toMatch(/state/)
    expect(txCalls).toBe(0)
    expect((await db.states.get(words[0]!.id))?.reps).toBe(states[0]!.reps + 5)
  })

  it('>batchSize（1200/3页）分页不重复不截断', async () => {
    await resetDatabase()
    const inputs = Array.from({ length: 1200 }, (_, i) => ({ headword: `w${i}`, meanings: [{ cn: `义${i}` }] }))
    const deck = await createDeck({ name: 'page', words: inputs })
    const db = getDb()
    const words = await db.words.where('deckId').equals(deck.id).toArray()
    await db.states.bulkPut(words.map((word) => ({ ...buildInitialState(word, 100), phase: 'review' as const })))
    const stateRows = (await db.states.toArray()).map(stateRow)
    const settingRows = (await db.settings.toArray()).map((row) => ({ key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt }))
    const mock = install(stateRows, () => ({ states: 1200, plans: 0, settings: settingRows.length, reviewLogs: 0 }), settingRows)
    const result = await rebuildIdbCacheFromSqlite({
      dryRun: false,
      unsafe: true,
      batchSize: 400,
      sqliteTxImpl: async () => ({ ok: true }),
    })
    expect(result.ok).toBe(true)
    expect(result.cacheCounts?.states).toBe(1200)
    expect(await db.states.count()).toBe(1200)
    expect(mock.statePages.count).toBe(4) // 3 个数据页 + 1 个空页确认结束
  })

  it('health 缺少 counts 直接拒绝，不用行数兜底', async () => {
    await seed()
    const db = getDb()
    const states = await db.states.toArray()
    install(states.map(stateRow), () => ({}))
    const result = await rebuildIdbCacheFromSqlite({ dryRun: false, unsafe: true })
    expect(result.ok).toBe(false)
    expect(result.error ?? result.conflict).toMatch(/counts|分叉/)
    expect(await db.states.count()).toBe(states.length)
  })

  it('无备份拒绝（非 unsafe）', async () => {
    await seed()
    const db = getDb()
    const states = await db.states.toArray()
    const settingRows = (await db.settings.toArray()).map((row) => ({ key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt }))
    install(states.map(stateRow), () => ({ states: 2, plans: 0, settings: 1, reviewLogs: 0 }), settingRows)
    const result = await rebuildIdbCacheFromSqlite({ dryRun: false })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/备份/)
  })
})

describe('task-312 C-07 force safe rebuild', () => {
  it('分叉 + force + preBackup → 以 SQLite 为准重建 IDB，不再反向覆盖', async () => {
    const { words } = await seed()
    const db = getDb()
    const states = await db.states.toArray()
    const sqliteStates = states.map(stateRow)
    await db.states.put({ ...states[0]!, reps: states[0]!.reps + 5 })
    const settingRows = (await db.settings.toArray()).map((row) => ({ key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt }))
    install(sqliteStates, () => ({ states: 2, plans: 0, settings: 1, reviewLogs: 0 }), settingRows)
    let backups = 0
    const result = await rebuildIdbCacheFromSqlite({
      dryRun: false, unsafe: true, force: true,
      preBackup: async () => { backups += 1; return { ok: true } },
      sqliteTxImpl: async () => { throw new Error('不应写 SQLite') },
    })
    expect(result.ok).toBe(true)
    expect(backups).toBe(1)
    expect((await db.states.get(words[0]!.id))?.reps).toBe(states[0]!.reps)
  })
})
