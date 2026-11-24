/** 0.10.0 短检：删词清理计划引用/恢复超时中止/写锁串行 */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendWordsToTodayPlan,
  buildDeckFile,
  buildInitialState,
  createDeck,
  deleteWord,
  getTodayPlan as getPlan,
  importDeckFile,
  getDb,
  getTodayPlan,
  resetDatabase,
  restoreAutoBackup,
  updateSettings,
  withDataWriteLock,
  type AutoBackupBridge,
  type AutoBackupEntry,
} from '../../src/data'

class FakeBridge implements AutoBackupBridge {
  files = new Map<string, string>()
  seq = 0
  isAvailable() { return true }
  save(text: string, name: string) { this.files.set(name, text); return { ok: true, mode: 'native' as const, name, path: `/p/${name}` } }
  list(): AutoBackupEntry[] { return [...this.files.entries()].map(([name, text]) => ({ name, size: text.length, mtime: ++this.seq, path: `/p/${name}` })) }
  read(name: string) { return this.files.get(name) ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag() { return '' }
  setFlag() { return true }
  appendDiagLog() {}
}

async function seedDeck() {
  await resetDatabase()
  const deck = await createDeck({ name: 'del', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  for (const word of words) await db.states.put({ ...buildInitialState(word, Date.now()), phase: 'review' })
  const plan = await appendWordsToTodayPlan({ wordIds: words.map((word) => word.id) })
  return { deck, words, plan: plan.plan }
}

describe('0.10.0 · integrity short', () => {
  beforeEach(async () => { await resetDatabase() })

  it('deleteWord 同步清理 plan.wordIds/sources/ratings/index', async () => {
    const { deck, words } = await seedDeck()
    const plan = await getTodayPlan({ deckId: deck.id })
    expect(plan.wordIds).toContain(words[0]!.id)
    await deleteWord(words[0]!.id)
    const after = await getTodayPlan({ deckId: deck.id })
    expect(after.wordIds).not.toContain(words[0]!.id)
    expect(after.sources[words[0]!.id]).toBeUndefined()
    expect(after.ratings.some((rating) => rating.wordId === words[0]!.id)).toBe(false)
    expect(after.index).toBeLessThanOrEqual(after.wordIds.length)
    expect(await getDb().words.get(words[0]!.id)).toBeUndefined()
  })

  it('importDeckFile replace：diff 词表 + plan 清理', async () => {
    const { deck, words } = await seedDeck()
    const db = getDb()
    const file = await buildDeckFile(deck.id)
    file.words = file.words.filter((word) => word.id !== words[0]!.id)
    await db.reviewLogs.add({
      wordId: words[0]!.id, deckId: deck.id, rating: 'familiar', reviewedAt: Date.now(),
      stabilityBefore: 1, difficultyBefore: 5, stabilityAfter: 1, difficultyAfter: 5,
      elapsedDays: 0, nextIntervalDays: 1, retrievabilityAtReview: 0.9,
      longTermUpdate: true, corrected: false, meaningChanges: [], phaseBefore: 'review', phaseAfter: 'review',
    } as never)
    await importDeckFile(JSON.stringify(file), { strategy: 'replace', preBackup: async () => ({ ok: true }) })
    expect(await db.words.get(words[0]!.id)).toBeUndefined()
    expect(await db.words.get(words[1]!.id)).toBeTruthy()
    const plan = await getPlan({ deckId: deck.id })
    expect(plan.wordIds).not.toContain(words[0]!.id)
    expect(plan.sources[words[0]!.id]).toBeUndefined()
    expect(await db.states.get(words[0]!.id)).toBeUndefined()
    expect(await db.reviewLogs.where('wordId').equals(words[0]!.id).count()).toBe(0)
  })

  it('restore 超时后 import 回调被取消，不写 states', async () => {
    await resetDatabase()
    const bridge = new FakeBridge()
    bridge.files.set('x.json.gz', JSON.stringify({ format: 'momo-migration', formatVersion: 1, dataVersion: 1, data: {} }))
    const report = { ok: true, issues: [], counts: { decks: 0, words: 0, states: 0, reviewLogs: 0, skipped: 0 }, startedAt: 0, finishedAt: 0, durationMs: 0, format: 'migration' }
    const stateCount = await getDb().states.count()
    const result = await restoreAutoBackup(bridge, 'x.json.gz', {
      skipPreBackup: true,
      timeoutMs: 1000,
      importImpl: async (_text, opts) => {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        ;(opts?.onProgress as ((p: unknown) => void) | undefined)?.({ phase: 'apply' })
        await getDb().states.put({ ...buildInitialState({ id: 'x', deckId: 'd', meanings: [], examples: [], mnemonics: [], phrases: [], headword: 'x', headwordLower: 'x', order: 0, createdAt: 0 } as never, 0) })
        return report as never
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/超时/)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(await getDb().states.count()).toBe(stateCount)
  })

  it('写锁串行：两个并发写不交错', async () => {
    const order: string[] = []
    await Promise.all([
      withDataWriteLock(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end') }),
      withDataWriteLock(async () => { order.push('b-start'); await new Promise((r) => setTimeout(r, 5)); order.push('b-end') }),
    ])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })
})
