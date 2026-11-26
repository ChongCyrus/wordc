/** M4 门禁：plan completed_at<=0→NULL、idx clamp、wordIds 回退；修 SQLite+IDB */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendWordsToTodayPlan,
  buildInitialState,
  createDeck,
  getDb,
  getHomeStudyData,
  healTodayPlanAfterStartup,
  getRawPlanDiagnostics,
  getTodayPlan,
  repairMigratedPlans,
  resetDatabase,
  setSqliteTransport,
  updateSettings,
} from '../../src/data'

function install(planRows: Array<Record<string, unknown>>): { txOps: unknown[][] } {
  const txOps: unknown[][] = []
  let seq = 0
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string; offset?: number; limit?: number } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') callback?.(id, JSON.stringify({ ok: true, userVersion: 1, counts: { states: 1, plans: 1, settings: 1, review_logs: 0 } }))
        else if (req.payload?.table === 'plans') {
          const offset = Number(req.payload?.offset ?? 0)
          const limit = Number(req.payload?.limit ?? planRows.length)
          callback?.(id, JSON.stringify({ ok: true, rows: planRows.slice(offset, offset + limit) }))
        }
        else callback?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { txOps }
}

async function seedPlan() {
  await resetDatabase()
  const deck = await createDeck({ name: 'repair', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  for (const word of words) await db.states.put({ ...buildInitialState(word, 1), phase: 'review' })
  const result = await appendWordsToTodayPlan({ wordIds: words.map((word) => word.id) })
  return { plan: result.plan, words }
}

afterEach(() => setSqliteTransport(null))

describe('0.11.0 · M4 plan repair', () => {
  it('SQLite plan completed_at=0/idx 越界/wordIds 空 → repair 正常化，IDB 同步', async () => {
    const { plan, words } = await seedPlan()
    const row = {
      id: plan.id, date: plan.date, deck_id: plan.deckId,
      word_ids_json: '[]', idx: 999, sources_json: '{}', goals_json: '{}', ratings_json: '[]',
      created_at: plan.createdAt, updated_at: plan.updatedAt, completed_at: 0,
    }
    const mock = install([row])
    const dry = await repairMigratedPlans({ dryRun: true })
    expect(dry.ok).toBe(true)
    expect(dry.changes).toHaveLength(1)
    expect(dry.changes[0]!.after).toMatchObject({ completedAt: null, index: 0, wordIds: 2 })
    const real = await repairMigratedPlans({
      dryRun: false,
      unsafe: true,
      sqliteTxImpl: async (ops) => { mock.txOps.push(ops); return { ok: true } },
    })
    expect(real.ok).toBe(true)
    expect(real.applied).toBe(1)
    const opRow = (mock.txOps[0]![0] as { row: Record<string, unknown> }).row
    expect(opRow.completed_at).toBeNull()
    expect(opRow.idx).toBe(0)
    expect(JSON.parse(String(opRow.word_ids_json))).toHaveLength(2)
    // IDB cache 同步：completedAt 归一化为 null
    const cached = await getDb().plans.get(plan.id)
    expect(cached?.completedAt).toBeNull()
    expect(cached?.index).toBe(0)
    expect(words.length).toBe(2)
  })

  it('completedAt=null 但 index 已满 → repair 回到 index0；raw 诊断可见', async () => {
    const { plan, words } = await seedPlan()
    const row = {
      id: plan.id, date: plan.date, deck_id: plan.deckId,
      word_ids_json: JSON.stringify(words.map((word) => word.id)), idx: 2, sources_json: '{}', goals_json: '{}', ratings_json: '[]',
      created_at: plan.createdAt, updated_at: plan.updatedAt, completed_at: null,
    }
    await (await import('../../src/data/idb-cache')).clearIdbCacheDirty({ generation: await (await import('../../src/data/data-epoch')).getDataEpoch(), sqliteUserVersion: 3, dirty: false })
    install([row])
    const diag = await getRawPlanDiagnostics()
    expect(diag.sqlitePlans[0]).toMatchObject({ completedAtRaw: null, indexRaw: 2, wordIdsLength: 2 })
    const dry = await repairMigratedPlans({ dryRun: true })
    expect(dry.changes).toHaveLength(1)
    expect(dry.changes[0]!.after).toMatchObject({ completedAt: null, index: 0, wordIds: 2 })
    const real = await repairMigratedPlans({ dryRun: false, unsafe: true, sqliteTxImpl: async () => ({ ok: true }) })
    expect(real.ok).toBe(true)
    expect((await getDb().plans.get(plan.id))?.index).toBe(0)
  })

  it('getTodayPlan 自愈：completedAt=0→null；index 满但 completedAt=null→index0', async () => {
    const { plan } = await seedPlan()
    const db = getDb()
    await db.plans.put({ ...plan, completedAt: 0 })
    const healedCompleted = await getTodayPlan()
    expect(healedCompleted.completedAt).toBeNull()
    await db.plans.put({ ...healedCompleted, index: healedCompleted.wordIds.length })
    const healedIndex = await getTodayPlan()
    expect(healedIndex.completedAt).toBeNull()
    expect(healedIndex.index).toBe(0)
    expect((await db.plans.get(plan.id))?.index).toBe(0)
  })

  it('M4b-1 不覆盖 IDB 新 plan：SQLite 旧快照 872 不反向覆盖 IDB 172', async () => {
    const { plan, words } = await seedPlan()
    const db = getDb()
    await db.plans.put({ ...plan, index: 0 })
    const sqliteRows = Array.from({ length: 5 }, (_, i) => ({
      id: plan.id, date: plan.date, deck_id: plan.deckId,
      word_ids_json: JSON.stringify([...words.map((word) => word.id), `extra-${i}`]), idx: 0,
      sources_json: JSON.stringify(plan.sources), goals_json: JSON.stringify(plan.goals), ratings_json: '[]',
      created_at: plan.createdAt, updated_at: plan.updatedAt, completed_at: null,
    }))
    await (await import('../../src/data/idb-cache')).clearIdbCacheDirty({ generation: await (await import('../../src/data/data-epoch')).getDataEpoch(), sqliteUserVersion: 3, dirty: false })
    install(sqliteRows)
    const home = await getHomeStudyData()
    expect(home.plan?.wordIds.length).toBe(plan.wordIds.length) // IDB 172，不强制 SQLite 872
    await healTodayPlanAfterStartup()
    expect((await db.plans.get(plan.id))?.wordIds.length).toBe(plan.wordIds.length)
  })

  it('M4b-1 启动自愈不改 wordIds/newBudget（plan 单源留 M4b2）', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'queue', words: Array.from({ length: 6 }, (_, i) => ({ headword: `q${i}`, meanings: [{ cn: `义${i}` }] })) })
    await updateSettings({ 'data.selectedDeckId': deck.id, 'study.dailyGoal': 5 })
    const db = getDb()
    const words = await db.words.where('deckId').equals(deck.id).toArray()
    const result = await appendWordsToTodayPlan({ wordIds: [words[0]!.id] })
    await db.plans.put({ ...result.plan, goals: { ...result.plan.goals, newBudget: 0, dueCount: 0 } })
    const healed = await healTodayPlanAfterStartup()
    expect(healed!.wordIds.length).toBe(1)
    expect((await db.plans.get(result.plan.id))!.wordIds.length).toBe(1)
  })

  it('>1000 plans 分页全量扫描，不漏修', async () => {
    await seedPlan()
    const planRows = Array.from({ length: 1200 }, (_, i) => ({
      id: `p${String(i).padStart(4, '0')}`, date: '2026-11-23', deck_id: 'd',
      word_ids_json: '[]', idx: 0, sources_json: '{}', goals_json: '{}', ratings_json: '[]',
      created_at: 1, updated_at: 1, completed_at: i === 1100 ? 0 : null,
    }))
    await (await import('../../src/data/idb-cache')).clearIdbCacheDirty({ generation: await (await import('../../src/data/data-epoch')).getDataEpoch(), sqliteUserVersion: 3, dirty: false })
    install(planRows)
    const result = await repairMigratedPlans({ dryRun: true })
    expect(result.ok).toBe(true)
    expect(result.scanned).toBe(1200)
    expect(result.changes.some((change) => change.id === 'p1100')).toBe(true)
  })

  it('无备份拒绝', async () => {
    await seedPlan()
    const plan = (await getDb().plans.toArray())[0]!
    await (await import('../../src/data/idb-cache')).clearIdbCacheDirty({ generation: await (await import('../../src/data/data-epoch')).getDataEpoch(), sqliteUserVersion: 3, dirty: false })
    install([{ id: plan.id, date: plan.date, deck_id: plan.deckId, word_ids_json: '[]', idx: 0, sources_json: '{}', goals_json: '{}', ratings_json: '[]', created_at: 1, updated_at: 1, completed_at: 0 }])
    const result = await repairMigratedPlans({ dryRun: false })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/备份/)
  })
})
