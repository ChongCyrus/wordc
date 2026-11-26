/** M4b-2-1：复杂 plan-only sqlite 分发/拒绝不双源 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendWordsToTodayPlan,
  buildInitialState,
  createDeck,
  getDb,
  localDateKey,
  persistLearningWriteSource,
  planIdOf,
  removeUnlearnedAutoNewWords,
  resetDatabase,
  setSqliteTransport,
  undoLastRating,
  reRateInPlan,
  updateSettings,
} from '../../src/data'

function install(opts: { planRow?: Record<string, unknown>; reviewRows?: unknown[]; failTx?: boolean } = {}) {
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
        if (req.payload?.table === 'plans') callback?.(id, JSON.stringify({ ok: true, rows: opts.planRow ? [opts.planRow] : [] }))
        else if (req.payload?.table === 'review_logs') callback?.(id, JSON.stringify({ ok: true, rows: opts.reviewRows ?? [] }))
        else callback?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { txs }
}

async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'plan-sqlite', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }, { headword: 'b', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  const plan = {
    id: planIdOf(localDateKey(Date.now()), deck.id), date: localDateKey(Date.now()), deck_id: deck.id,
    word_ids_json: JSON.stringify([words[0]!.id]), idx: 0,
    sources_json: JSON.stringify({ [words[0]!.id]: 'manual' }), goals_json: '{}', ratings_json: '[]',
    created_at: Date.now(), updated_at: Date.now(), completed_at: null,
  }
  await db.plans.put({ id: plan.id, date: plan.date, deckId: deck.id, wordIds: [words[0]!.id], index: 0, sources: { [words[0]!.id]: 'manual' }, goals: { dailyGoal: 10, dueCount: 0, newBudget: 0, extraCount: 0 }, ratings: [], createdAt: plan.created_at, updatedAt: plan.updated_at, completedAt: null } as never)
  return { deck, words, plan }
}

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb')
})

describe('0.11.0 · M4b-2-1 plan-only sqlite', () => {
  it('append sqlite tx 失败：IDB plan 不变；成功写 cache', async () => {
    const { words, plan } = await seed()
    await persistLearningWriteSource('sqlite')
    const db = getDb()
    const before = await db.plans.get(plan.id)
    install({ planRow: plan, failTx: true })
    await expect(appendWordsToTodayPlan({ wordIds: [words[1]!.id] })).rejects.toThrow()
    expect(await db.plans.get(plan.id)).toEqual(before)
    install({ planRow: plan })
    const result = await appendWordsToTodayPlan({ wordIds: [words[1]!.id], clientOpId: 'append-1' })
    expect(result.added).toBe(1)
    expect((await db.plans.get(plan.id))?.wordIds.length).toBe(2)
  })

  it('remove sqlite 可用；无 undoable log 时 undo 返回 null 且 IDB 不写', async () => {
    const { words, plan } = await seed()
    await persistLearningWriteSource('sqlite')
    const db = getDb()
    await db.states.put({ ...buildInitialState(words[0]!, 1), phase: 'new' })
    install({ planRow: plan })
    const removed = await removeUnlearnedAutoNewWords()
    expect(removed.removed).toBeGreaterThanOrEqual(0)
    const beforePlan = await db.plans.get(plan.id)
    await expect(undoLastRating({ wordId: words[0]!.id })).resolves.toBeNull()
    expect(await db.plans.get(plan.id)).toEqual(beforePlan)
  })

  it('reRate sqlite 单事务：tx fail 不写 IDB；成功返回新 state/plan', async () => {
    const { deck, words, plan } = await seed()
    await persistLearningWriteSource('sqlite')
    const db = getDb()
    const now = Date.now()
    const beforeState = buildInitialState(words[0]!, now)
    await db.states.put(beforeState)
    const reviewRow = {
      id: 1, word_id: words[0]!.id, deck_id: deck.id, rating: 'forgot', reviewed_at: now,
      corrected: 0, long_term_update: 0, state_before_json: null,
    }
    const beforePlan = await db.plans.get(plan.id)
    const beforeStateRow = await db.states.get(words[0]!.id)
    install({ planRow: plan, reviewRows: [reviewRow], failTx: true })
    await expect(reRateInPlan({ wordId: words[0]!.id, rating: 'familiar', planId: plan.id })).rejects.toThrow()
    expect(await db.plans.get(plan.id)).toEqual(beforePlan)
    expect(await db.states.get(words[0]!.id)).toEqual(beforeStateRow)

    install({ planRow: plan, reviewRows: [reviewRow] })
    const result = await reRateInPlan({ wordId: words[0]!.id, rating: 'familiar', planId: plan.id })
    expect(result).not.toBeNull()
    expect(result!.state.wordId).toBe(words[0]!.id)
    expect(result!.plan.id).toBe(plan.id)
  })
})
