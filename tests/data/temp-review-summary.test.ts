/** 0.3.94/task-278：practice 逐词自评/跳过 + 汇总；rate 汇总 DHP 标记 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildInitialState,
  captureTempReviewSnapshot,
  createDeck,
  getDb,
  rateTempReview,
  recordPracticeSelfRating,
  resetDatabase,
  skipPracticeWord,
  startTempReview,
  summarizePracticeReview,
  summarizeTempReview,
  advanceTempReviewBatch,
  applyTempReviewToDhp,
  updateSettings,
} from '../../src/data'
import { coreSenseStatKey } from '../../src/core'

async function setup() {
  const deck = await createDeck({
    name: 'temp-summary',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲' }] },
      { headword: 'beta', meanings: [{ cn: '乙' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  const state = buildInitialState(words[0]!, Date.now())
  await db.states.put({
    ...state,
    phase: 'learning',
    meaningStats: { [words[0]!.meanings[0]!.id]: { clicks: 1, encounters: 2 } },
    coreSenseStats: { [coreSenseStatKey(1, '本义')]: { clicks: 2, encounters: 4 } },
  })
  return { words: words.sort((a, b) => a.order - b.order) }
}

describe('0.3.94 · temp review summary', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('practice 逐词自评/跳过只存内存，汇总前/后不熟悉度且零写库', async () => {
    const { words } = await setup()
    const db = getDb()
    const beforeLogs = await db.reviewLogs.count()
    const beforeState = await db.states.get(words[0]!.id)
    let session = await startTempReview({ wordIds: [words[0]!.id, words[1]!.id], recordMode: 'practice' })
    const snap = (await captureTempReviewSnapshot(words[0]!.id))!
    expect(snap.meaningFamiliarity[words[0]!.meanings[0]!.id]).toBe(0.5)
    session = recordPracticeSelfRating(session, { wordId: words[0]!.id, rating: 'familiar', durationMs: 1200 })
    session = skipPracticeWord(session, { wordId: words[1]!.id, durationMs: 800 })
    // 非持久化：DB 未变
    expect(await db.reviewLogs.count()).toBe(beforeLogs)
    expect(await db.states.get(words[0]!.id)).toEqual(beforeState)
    const summary = await summarizePracticeReview(session)
    expect(summary.recordMode).toBe('practice')
    expect(summary.items).toHaveLength(2)
    expect(summary.items[0]!.rating).toBe('familiar')
    expect(summary.items[0]!.dhpAffected).toBe(false)
    expect(summary.items[0]!.durationMs).toBe(1200)
    expect(summary.items[0]!.before?.meaningFamiliarity[words[0]!.meanings[0]!.id]).toBe(0.5)
    expect(summary.items[0]!.after).toEqual(summary.items[0]!.before)
    expect(summary.items[1]!.rating).toBeNull()
    expect(summary.totalDurationMs).toBe(2000)
  })

  it('0.3.94/task-280 autoRequeue：模糊/忘记只在本批插入 occurrence，不写库', async () => {
    const { words } = await setup()
    const db = getDb()
    const beforeLogs = await db.reviewLogs.count()
    let session = await startTempReview({ wordIds: [words[0]!.id, words[1]!.id], recordMode: 'practice', autoRequeue: true })
    expect(session.queue).toHaveLength(2)
    const beforeState = await db.states.get(words[0]!.id)
    session = advanceTempReviewBatch(session, { queueIndex: 0, rating: 'vague', durationMs: 100 })
    expect(session.queue).toHaveLength(3)
    expect(session.queue!.at(-1)).toMatchObject({ wordId: words[0]!.id, occurrence: 2, isRequeue: true })
    expect(session.outcomes).toHaveLength(1)
    // 认识不插入
    const noRequeue = await startTempReview({ wordIds: [words[0]!.id], recordMode: 'practice' })
    const advanced = advanceTempReviewBatch(noRequeue, { queueIndex: 0, rating: 'forgot', durationMs: 50 })
    expect(advanced.queue!.length).toBe(1)
    expect(await db.reviewLogs.count()).toBe(beforeLogs)
    expect(await db.states.get(words[0]!.id)).toEqual(beforeState)
    const practiceSummary = await summarizePracticeReview(
      recordPracticeSelfRating(session, { wordId: words[0]!.id, rating: 'vague', durationMs: 100 }),
    )
    expect(practiceSummary.occurrences).toHaveLength(1)
    expect(practiceSummary.occurrences![0]).toMatchObject({ wordId: words[0]!.id, occurrence: 1, isRequeue: false })
  })

  it('0.3.94/task-280 apply to DHP：practice 应用并幂等；rate 跳过一次', async () => {
    const { words } = await setup()
    const db = getDb()
    const practice = await startTempReview({ wordIds: [words[0]!.id], recordMode: 'practice' })
    let applied1 = await applyTempReviewToDhp(practice, [{ wordId: words[0]!.id, rating: 'familiar', durationMs: 100 }])
    expect(applied1.ok).toBe(true)
    expect(applied1.applied).toBe(1)
    const logsAfter = await db.reviewLogs.count()
    const stateAfter = await db.states.get(words[0]!.id)
    expect(stateAfter?.lastReviewedAt).toBeTruthy()
    const applied2 = await applyTempReviewToDhp(practice)
    expect(applied2.applied).toBe(0)
    expect(await db.reviewLogs.count()).toBe(logsAfter)
    // rate 已应用 → 不再重复
    const rateSession = await startTempReview({ wordIds: [words[0]!.id], recordMode: 'rate' })
    const rateApply = await applyTempReviewToDhp(rateSession)
    expect(rateApply.applied).toBe(0)
    expect(rateApply.skippedAlreadyDhp).toBe(1)
  })

  it('rate 模式汇总 dhpAffected=true，after 反映新统计', async () => {
    const { words } = await setup()
    const before = (await captureTempReviewSnapshot(words[0]!.id))!
    const session = await startTempReview({ wordIds: [words[0]!.id], recordMode: 'rate' })
    await rateTempReview({ wordId: words[0]!.id, rating: 'familiar', recordMode: 'rate' })
    const summary = await summarizeTempReview(session, [
      { wordId: words[0]!.id, rating: 'familiar', durationMs: 500, before },
    ])
    expect(summary.items[0]!.dhpAffected).toBe(true)
    expect(summary.items[0]!.after).not.toBeNull()
  })
})
