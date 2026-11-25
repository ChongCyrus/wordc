/** 0.11.0 M4b-2-0：IDB 当前 plan → SQLite reconcile（不反向） */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendWordsToTodayPlan,
  createDeck,
  getDb,
  getDataEpoch,
  reconcileTodayPlanToSqlite,
  resetDatabase,
  setSqliteTransport,
  localDateKey,
  updateSettings,
} from '../../src/data'

async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'reconcile', words: Array.from({ length: 5 }, (_, i) => ({ headword: `r${i}`, meanings: [{ cn: `义${i}` }] })) })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  const plan = (await appendWordsToTodayPlan({ wordIds: words.slice(0, 2).map((word) => word.id) })).plan
  return { deck, words, plan }
}

function install(stalePlan: Record<string, unknown>) {
  let seq = 0
  const plans: Array<Record<string, unknown>> = [{ ...stalePlan }]
  const txs: unknown[][] = []
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string; where?: { id?: string } } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') {
          callback?.(id, JSON.stringify({ ok: true, userVersion: 3, counts: { states: 1, plans: plans.length, settings: 1, review_logs: 0 } }))
          return
        }
        if (req.method === 'tx') {
          txs.push(req.ops ?? [])
          for (const op of req.ops ?? []) {
            const item = op as { table?: string; row?: Record<string, unknown>; where?: { id?: string } }
            if (item.table === 'plans' && item.row) {
              const index = plans.findIndex((plan) => plan.id === item.row!.id)
              if (index >= 0) plans[index] = item.row
              else plans.push(item.row)
            }
          }
          callback?.(id, JSON.stringify({ ok: true }))
          return
        }
        const wanted = req.payload?.where?.id
        callback?.(id, JSON.stringify({ ok: true, rows: wanted ? plans.filter((plan) => plan.id === wanted) : plans }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { plans, txs }
}

afterEach(() => setSqliteTransport(null))

describe('0.11.0 · M4b-2 plan reconcile', () => {
  it('SQLite 872/旧快照不覆盖 IDB 172；reconcile 后 SQLite=IDB', async () => {
    const { deck, plan } = await seed()
    const stale = {
      id: plan.id, date: plan.date, deck_id: deck.id,
      word_ids_json: JSON.stringify(Array.from({ length: 5 }, (_, i) => `stale-${i}`)), idx: 0,
      sources_json: '{}', goals_json: '{}', ratings_json: '[]',
      created_at: plan.createdAt, updated_at: plan.updatedAt - 1000, completed_at: null,
    }
    const mock = install(stale)
    const dry = await reconcileTodayPlanToSqlite({ dryRun: true })
    expect(dry.ok).toBe(true)
    expect(dry.changed).toBe(true)
    expect(dry.idb?.wordIdsLength).toBe(plan.wordIds.length)
    expect(dry.sqlite?.wordIdsLength).toBe(5)
    expect(mock.txs).toHaveLength(0)
    const beforeEpoch = await getDataEpoch()
    let backups = 0
    const real = await reconcileTodayPlanToSqlite({
      dryRun: false,
      preBackup: async () => { backups += 1; return { ok: true } },
      sqliteTxImpl: async (ops: unknown[]) => {
        mock.txs.push(ops)
        for (const op of ops) {
          const item = op as { row?: Record<string, unknown> }
          const index = mock.plans.findIndex((row) => row.id === item.row!.id)
          if (index >= 0) mock.plans[index] = item.row!
        }
        return { ok: true }
      },
    })
    expect(real.ok).toBe(true)
    expect(real.changed).toBe(true)
    expect(backups).toBe(1)
    expect(JSON.parse(String(mock.plans[0]!.word_ids_json))).toHaveLength(plan.wordIds.length)
    expect(await getDataEpoch()).toBe(beforeEpoch + 1)
    expect(localDateKey(real.idb?.updatedAt ?? Date.now())).toBeTruthy()
  })

  it('备份失败拒绝；已一致时幂等 changed=false', async () => {
    const { deck, plan } = await seed()
    const same = {
      id: plan.id, date: plan.date, deck_id: deck.id,
      word_ids_json: JSON.stringify(plan.wordIds), idx: plan.index,
      sources_json: JSON.stringify(plan.sources), goals_json: JSON.stringify(plan.goals), ratings_json: '[]',
      created_at: plan.createdAt, updated_at: plan.updatedAt, completed_at: plan.completedAt,
    }
    const stale = { ...same, word_ids_json: JSON.stringify(['stale-a', 'stale-b', 'stale-c']), updated_at: plan.updatedAt - 1000 }
    install(stale)
    const fail = await reconcileTodayPlanToSqlite({ dryRun: false, preBackup: async () => ({ ok: false, error: 'mock' }) })
    expect(fail.ok).toBe(false)
    expect(fail.error).toMatch(/备份/)
    install(same)
    const idem = await reconcileTodayPlanToSqlite({ dryRun: false, preBackup: async () => ({ ok: true }) })
    expect(idem.ok).toBe(true)
    expect(idem.changed).toBe(false)
  })
})
