import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { appendWordsToTodayPlan, buildInitialState, createDeck, deleteDeck, deleteWord, getDb, localDateKey, persistLearningWriteSource, planIdOf, resetDatabase, setSqliteTransport, updateSettings } from '../../src/data'
function install(planRows: Array<Record<string, unknown>>, fail = false) {
  let seq = 0; let ops: unknown[][] = []
  setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'tx') { ops.push(req.ops ?? []); cb?.(id, JSON.stringify(fail ? { ok: false, code: 'E_IO', message: 'mock fail' } : { ok: true })); return } cb?.(id, JSON.stringify({ ok: true, rows: req.payload?.table === 'plans' ? planRows : [] })) }, 0); return JSON.stringify({ requestId: id }) } } as never)
  return { get ops() { return ops } }
}
async function seed() { await resetDatabase(); const deck = await createDeck({ name: 'a2', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }, { headword: 'b', meanings: [{ cn: '乙' }] }] }); await updateSettings({ 'data.selectedDeckId': deck.id }); const db = getDb(); const words = await db.words.where('deckId').equals(deck.id).toArray(); for (const w of words) await db.states.put({ ...buildInitialState(w, 1), phase: 'review' }); const plan = (await appendWordsToTodayPlan({ wordIds: words.map((w) => w.id) })).plan; return { deck, words, plan } }
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb') })
describe('A2 delete sqlite', () => {
  it('deleteWord 单 tx + IDB cache；失败 IDB 不变', async () => {
    const { words } = await seed(); await persistLearningWriteSource('sqlite'); const db = getDb()
    const planRow = { id: planIdOf(localDateKey(Date.now()), words[0]!.deckId), date: localDateKey(Date.now()), deck_id: words[0]!.deckId, word_ids_json: JSON.stringify(words.map((w) => w.id)), idx: 0, sources_json: '{}', goals_json: '{}', ratings_json: '[]', created_at: 1, updated_at: 1, completed_at: null }
    const mock = install([planRow]); await deleteWord(words[0]!.id)
    expect(mock.ops).toHaveLength(1); expect(await db.states.get(words[0]!.id)).toBeUndefined(); expect((await db.states.get(words[1]!.id))).toBeTruthy()
    install([planRow], true)
    await expect(deleteWord(words[1]!.id)).rejects.toThrow()
    expect(await db.states.get(words[1]!.id)).toBeTruthy()
  })
  it('deleteDeck 单 tx；IDB deck/states 清除', async () => {
    const { deck } = await seed(); await persistLearningWriteSource('sqlite'); install([]); await deleteDeck(deck.id, { preBackup: async () => ({ ok: true }) }); expect(await getDb().decks.get(deck.id)).toBeUndefined(); expect(await getDb().states.where('deckId').equals(deck.id).count()).toBe(0)
  })
})
