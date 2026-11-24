/** M4b-2-1：arch 单 tx reRate 复核 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInitialState,
  createDeck,
  getDb,
  localDateKey,
  persistLearningWriteSource,
  planIdOf,
  reRateInPlanSqlite,
  resetDatabase,
  setSqliteTransport,
  updateSettings,
} from '../../src/data'

function install(opts: { planRow: Record<string, unknown>; logRow: Record<string, unknown>; failTx?: boolean; cached?: unknown }) {
  const txs: unknown[][] = []
  let seq = 0
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'tx') {
          txs.push(req.ops ?? [])
          callback?.(id, JSON.stringify(opts.failTx ? { ok: false, code: 'E_IO', message: 'mock tx fail' } : { ok: true }))
          return
        }
        if (req.payload?.table === 'plans') callback?.(id, JSON.stringify({ ok: true, rows: [opts.planRow] }))
        else if (req.payload?.table === 'review_logs') callback?.(id, JSON.stringify({ ok: true, rows: [{ ...opts.logRow, corrected: 0 }] }))
        else if (req.payload?.table === 'client_ops') callback?.(id, JSON.stringify({ ok: true, rows: opts.cached ? [{ op_id: 'rerate-op', result_json: JSON.stringify(opts.cached) }] : [] }))
        else callback?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { txs }
}

async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'rerate', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
  const state = { ...buildInitialState(word, 100), phase: 'review' as const }
  const planId = planIdOf(localDateKey(Date.now()), deck.id)
  const plan = {
    id: planId, date: localDateKey(Date.now()), deckId: deck.id, wordIds: [word.id], index: 1,
    sources: { [word.id]: 'goal' as const }, goals: { dailyGoal: 1, dueCount: 1, newBudget: 0, extraCount: 0 },
    ratings: [{ wordId: word.id, rating: 'familiar' as const, reviewedAt: Date.now(), corrected: false }],
    createdAt: 1, updatedAt: 100, completedAt: null,
  }
  await db.plans.put(plan as never)
  await db.states.put(state)
  const logRow = {
    id: 7, word_id: word.id, deck_id: deck.id, rating: 'familiar', reviewed_at: Date.now(),
    stability_before: 1, difficulty_before: 5, stability_after: 1, difficulty_after: 5,
    elapsed_days: 0, next_interval_days: 1, retrievability_at_review: 0.9,
    long_term_update: 1, corrected: 0, phase_before: 'review', phase_after: 'review',
    state_before_json: JSON.stringify({ ...state, phase: 'new' }),
  }
  const planRow = {
    id: plan.id, date: plan.date, deck_id: plan.deckId, word_ids_json: JSON.stringify(plan.wordIds),
    idx: 0, sources_json: JSON.stringify(plan.sources), goals_json: JSON.stringify(plan.goals),
    ratings_json: JSON.stringify(plan.ratings), created_at: 1, updated_at: 100, completed_at: null,
  }
  return { word, state, plan, logRow, planRow }
}

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb')
})

describe('M4b-2-1 reRate sqlite', () => {
  it('tx 失败：SQLite/IDB state/log/plan 不变', async () => {
    const { word, plan, logRow, planRow } = await seed()
    await persistLearningWriteSource('sqlite')
    const db = getDb()
    const beforeState = await db.states.get(word.id)
    const beforePlan = await db.plans.get(plan.id)
    install({ planRow, logRow, failTx: true })
    await expect(reRateInPlanSqlite({ wordId: word.id, rating: 'forgot', planId: plan.id, clientOpId: 'rerate-op' })).rejects.toThrow()
    expect(await db.states.get(word.id)).toEqual(beforeState)
    expect(await db.plans.get(plan.id)).toEqual(beforePlan)
  })

  it('同 clientOpId 重放返回缓存，不产生 tx', async () => {
    const { word, plan, logRow, planRow } = await seed()
    await persistLearningWriteSource('sqlite')
    const cached = { state: { ...(await getDb().states.get(word.id)) }, plan }
    const mock = install({ planRow, logRow, cached })
    const replay = await reRateInPlanSqlite({ wordId: word.id, rating: 'forgot', planId: plan.id, clientOpId: 'rerate-op' })
    expect(replay?.plan.id).toBe(plan.id)
    expect(mock.txs).toHaveLength(0)
  })

  it('readonly 拒绝且不写', async () => {
    const { word, plan, logRow, planRow } = await seed()
    await persistLearningWriteSource('readonly')
    const db = getDb()
    const before = await db.states.get(word.id)
    install({ planRow, logRow })
    await expect(reRateInPlanSqlite({ wordId: word.id, rating: 'forgot', planId: plan.id })).rejects.toMatchObject({ code: 'LEARNING_READONLY' })
    expect(await db.states.get(word.id)).toEqual(before)
  })
})
