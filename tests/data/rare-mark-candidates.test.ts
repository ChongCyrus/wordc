/** 0.3.97/task-282：批量不常考候选/增量/checkedAt/apply/批次状态/导出兼容 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyRareMarkResults,
  buildInitialState,
  buildMigrationFile,
  clearRareMarkBatchJob,
  createDeck,
  getDb,
  getRareMarkBatchJob,
  getRareMarkCandidates,
  importMigration,
  RARE_MARK_VERSION,
  resetDatabase,
  saveRareMarkBatchJob,
  updateSettings,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'rare-batch',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲' }, { cn: '甲二' }] },
      { headword: 'beta', meanings: [{ cn: '乙' }] },
      { headword: 'gamma', meanings: [{ cn: '丙' }, { cn: '丙二' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
  const now = Date.now()
  const chapters = ['Unit 1', 'Unit 1', 'Unit 2']
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    await db.words.put({ ...word, chapter: chapters[i] })
    await db.packItems.put({
      id: `rare-${word.id}:1`,
      packId: `rare-${word.id}`,
      seq: 1,
      wordId: word.id,
      headword: word.headword,
      headwordLower: word.headwordLower,
      payload: { headword: word.headword, coreSenses: [{ index: 1, label: '本义' }] },
      status: 'applied',
      contentHashes: [],
      createdAt: now,
      appliedAt: now,
    })
  }
  // beta 已处理但 0 标记；gamma 已处理+有标记；alpha unchecked
  await db.words.put({ ...(await db.words.get(words[1]!.id))!, rareMarkCheckedAt: now, rareMarkVersion: RARE_MARK_VERSION })
  await db.words.put({
    ...(await db.words.get(words[2]!.id))!,
    rareMarkCheckedAt: now,
    rareMarkVersion: RARE_MARK_VERSION,
    rareMeaningIds: [words[2]!.meanings[0]!.id],
  })
  // beta 已学
  await db.states.put({ ...buildInitialState(words[1]!, now), phase: 'review' })
  return { deck, words }
}

describe('0.3.97 · rare mark candidates/apply', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('候选 source/状态 counts/分页 total 不截断', async () => {
    const { deck } = await setup()
    const all = await getRareMarkCandidates({ source: 'deck', deckId: deck.id, rareStatus: 'all', limit: 2, offset: 0 })
    expect(all.total).toBe(3)
    expect(all.words).toHaveLength(2)
    expect(all.counts).toMatchObject({ all: 3, unchecked: 1, unmarked: 1, marked: 1, learned: 1 })
    const unchecked = await getRareMarkCandidates({ source: 'deck', deckId: deck.id, rareStatus: 'unchecked' })
    expect(unchecked.total).toBe(1)
    expect(unchecked.words[0]!.word.headword).toBe('alpha')
    const page2 = await getRareMarkCandidates({ source: 'deck', deckId: deck.id, rareStatus: 'all', limit: 2, offset: 2 })
    expect(page2.words).toHaveLength(1)
    const unit = await getRareMarkCandidates({ source: 'unit', deckId: deck.id, chapter: 'Unit 1' })
    expect(unit.total).toBe(1) // beta 已 marked 不算 unchecked
    const learned = await getRareMarkCandidates({ source: 'filtered', deckId: deck.id, learned: true, rareStatus: 'all' })
    expect(learned.total).toBe(1)
    const selected = await getRareMarkCandidates({ source: 'selected', wordIds: [unchecked.words[0]!.word.id], rareStatus: 'all' })
    expect(selected.total).toBe(1)
    const today = await getRareMarkCandidates({ source: 'today', rareStatus: 'all' })
    expect(today.total).toBeGreaterThanOrEqual(0)
  })

  it('apply 逐含义/逐本义、保留已有标记、写 checkedAt/version、失败不 stamp', async () => {
    const { words } = await setup()
    const db = getDb()
    const alpha = words[0]!
    const gamma = words[2]!
    const result = await applyRareMarkResults(
      [
        { wordId: alpha.id, rareMeaningIndexes: [2], rareCoreSenseIndexes: [1] },
        { wordId: gamma.id, rareMeaningIndexes: [2] },
        { wordId: 'missing', error: 'AI 失败' },
      ],
      { now: 123456 },
    )
    expect(result.checked).toBe(2)
    expect(result.failed).toEqual([{ wordId: 'missing', error: 'AI 失败' }])
    const alphaAfter = (await db.words.get(alpha.id))!
    expect(alphaAfter.rareMarkCheckedAt).toBe(123456)
    expect(alphaAfter.rareMarkVersion).toBe(RARE_MARK_VERSION)
    expect(alphaAfter.rareMeaningIds).toEqual([alpha.meanings[1]!.id])
    expect(alphaAfter.rareCoreSenses?.[0]).toMatchObject({ coreSenseIndex: 1, label: '本义' })
    // gamma 原有第一条标记保留，并集新增第二条
    const gammaAfter = (await db.words.get(gamma.id))!
    expect(gammaAfter.rareMeaningIds).toEqual([gamma.meanings[0]!.id, gamma.meanings[1]!.id])
    const missing = (await db.words.get('missing')) as unknown
    expect(missing).toBeUndefined()
  })

  it('0 rare 结果也 stamp checkedAt/version，二次 unchecked=0', async () => {
    const { deck, words } = await setup()
    const db = getDb()
    const alpha = words[0]!
    const before = await getRareMarkCandidates({ source: 'deck', deckId: deck.id, rareStatus: 'unchecked' })
    expect(before.total).toBe(1)
    const applied = await applyRareMarkResults([{ wordId: alpha.id, rareMeaningIndexes: [] }], { now: 456 })
    expect(applied.checked).toBe(1)
    expect(applied.updated).toBe(0)
    const word = (await db.words.get(alpha.id))!
    expect(word.rareMarkCheckedAt).toBe(456)
    expect(word.rareMarkVersion).toBe(RARE_MARK_VERSION)
    expect(word.rareMeaningIds ?? []).toEqual([])
    expect(word.rareCoreSenses ?? []).toEqual([])
    const after = await getRareMarkCandidates({ source: 'deck', deckId: deck.id, rareStatus: 'unchecked' })
    expect(after.total).toBe(0)
    expect(after.counts).toMatchObject({ all: 3, unchecked: 0, unmarked: 2, marked: 1 })
  })

  it('批次状态可持久化/继续/清理；导出含 checkedAt/version', async () => {
    const { deck, words } = await setup()
    await applyRareMarkResults([{ wordId: words[0]!.id, rareMeaningIndexes: [] }], { now: 222 })
    const job = {
      id: 'job1',
      source: 'deck' as const,
      filter: { deckId: deck.id, rareStatus: 'unchecked' as const },
      cursor: 1,
      failed: [{ wordId: 'x', error: 'timeout' }],
      results: [{ wordId: words[0]!.id, checkedAt: 222, markedCount: 0 }],
      createdAt: 1,
      updatedAt: 1,
    }
    await saveRareMarkBatchJob(job)
    expect(await getRareMarkBatchJob()).toMatchObject({ id: 'job1', cursor: 1, failed: job.failed })
    await clearRareMarkBatchJob()
    expect(await getRareMarkBatchJob()).toBeNull()

    const file = await buildMigrationFile({ includeReviewLogs: false })
    const exported = file.data.words.find((word) => word.id === words[0]!.id)!
    expect(exported.rareMarkCheckedAt).toBe(222)
    expect(exported.rareMarkVersion).toBe(RARE_MARK_VERSION)
    const report = await importMigration(JSON.stringify(file), { strategy: 'replace', force: true })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect((await getDb().words.get(words[0]!.id))?.rareMarkCheckedAt).toBe(222)
  })
})
