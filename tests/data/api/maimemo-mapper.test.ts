import { describe, expect, it } from 'vitest'

import { formatMaimemoDate } from '../../../src/data/api/maimemo-client'
import {
  interpretResponse,
  mapStudyRecord,
  mapStudyRecords,
  normalizeSpelling,
} from '../../../src/data/api/maimemo-mapper'
import type { MatchedWordInfo, RecordMatcher } from '../../../src/data/api/maimemo-mapper'
import type { StudyRecord } from '../../../src/data/api/maimemo-types'
import { initialStability, localDateKey, startOfLocalDay } from '../../../src/core'

const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime()
const DAY = 86_400_000

const MATCH: MatchedWordInfo = {
  wordId: 'test-deck:embrace',
  deckId: 'test-deck',
  meaningIds: ['test-deck:embrace#M1', 'test-deck:embrace#M2'],
  spelling: 'embrace',
}

function record(overrides: Partial<StudyRecord> = {}): StudyRecord {
  return {
    voc_id: 'voc-1',
    voc_spelling: 'embrace',
    first_study_date: formatMaimemoDate(NOW - 10 * DAY),
    last_study_date: formatMaimemoDate(NOW - 2 * DAY),
    next_study_date: formatMaimemoDate(NOW + 3 * DAY),
    last_response: 'FAMILIAR',
    study_count: 6,
    tags: [],
    ...overrides,
  }
}

describe('last_response 枚举解释（D43）', () => {
  it('五种官方枚举 + UNSPECIFIED + 未知值', () => {
    expect(interpretResponse('FAMILIAR').rating).toBe('familiar')
    expect(interpretResponse('VAGUE').rating).toBe('vague')
    expect(interpretResponse('FORGET').rating).toBe('forgot')
    expect(interpretResponse('WELL_FAMILIAR')).toMatchObject({ rating: 'familiar', wellFamiliar: true })
    expect(interpretResponse('CANCEL_WELL_FAMILIAR')).toMatchObject({ rating: 'familiar', wellFamiliar: false })
    expect(interpretResponse('STUDY_RESPONSE_UNSPECIFIED').rating).toBeNull()
    expect(interpretResponse(null).rating).toBeNull()
    expect(interpretResponse('SOMETHING_NEW')).toMatchObject({ rating: null, known: false })
  })
})

describe('单条 StudyRecord → WordState（SPEC §7.3）', () => {
  it('FAMILIAR：日期/到期/间隔反推 h/不熟悉度 0.5', () => {
    const last = NOW - 2 * DAY
    const next = NOW + 3 * DAY
    const state = mapStudyRecord(
      record({
        first_study_date: formatMaimemoDate(NOW - 10 * DAY),
        last_study_date: formatMaimemoDate(last),
        next_study_date: formatMaimemoDate(next),
        last_response: 'FAMILIAR',
        study_count: 6,
      }),
      MATCH,
      NOW,
    )
    expect(state.wordId).toBe(MATCH.wordId)
    expect(state.deckId).toBe(MATCH.deckId)
    expect(state.phase).toBe('review')
    expect(state.lastRating).toBe('familiar')
    expect(state.reps).toBe(6)
    expect(state.lapses).toBe(0)
    expect(state.dueAt).toBe(startOfLocalDay(next))
    expect(localDateKey(state.dueAt!)).toBe(localDateKey(next))
    // 间隔 5 天 → h = 5 / -log2(0.9)
    expect(state.nextIntervalDays).toBe(5)
    expect(state.stability).toBeCloseTo(5 / -Math.log2(0.9), 6)
    // 记忆持久度/不熟悉度近似
    expect(state.meaningStats[MATCH.meaningIds[0]!]).toEqual({ clicks: 1, encounters: 2 })
    expect(state.meaningStats[MATCH.meaningIds[1]!]).toEqual({ clicks: 1, encounters: 2 })
    expect(state.importedFrom).toBe('maimemo')
    expect(state.importedAt).toBe(NOW)
    expect(state.sameDayDate).toBe('')
    expect(state.difficulty).toBe(5)
  })

  it('FORGET 且次日到期 → learning', () => {
    const last = NOW - DAY
    const next = NOW
    const state = mapStudyRecord(
      record({
        last_study_date: formatMaimemoDate(last),
        next_study_date: formatMaimemoDate(next),
        last_response: 'FORGET',
      }),
      MATCH,
      NOW,
    )
    expect(state.phase).toBe('learning')
    expect(state.lastRating).toBe('forgot')
    expect(state.lapses).toBeGreaterThanOrEqual(1)
  })

  it('STICKING：difficulty=8、lapses=max(2,⌊count/3⌋)', () => {
    const state = mapStudyRecord(record({ tags: ['STICKING'], study_count: 9 }), MATCH, NOW)
    expect(state.difficulty).toBe(8)
    expect(state.lapses).toBe(3)
    const asString = mapStudyRecord(record({ tags: 'STICKING', study_count: 3 }), MATCH, NOW)
    expect(asString.difficulty).toBe(8)
    expect(asString.lapses).toBe(2)
  })

  it('WELL_FAMILIAR → mastered 且 dueAt=null', () => {
    const state = mapStudyRecord(record({ last_response: 'WELL_FAMILIAR' }), MATCH, NOW)
    expect(state.phase).toBe('mastered')
    expect(state.dueAt).toBeNull()
    expect(state.lastRating).toBe('familiar')
  })

  it('UNSPECIFIED：按见过一次未评分（h/d 初始值，不当答错，D43）', () => {
    const state = mapStudyRecord(
      record({ last_response: 'STUDY_RESPONSE_UNSPECIFIED', study_count: 1 }),
      MATCH,
      NOW,
    )
    expect(state.lastRating).toBeNull()
    expect(state.difficulty).toBe(5)
    expect(state.lapses).toBe(0)
    expect(state.stability).toBeCloseTo(initialStability(5), 6)
    expect(state.phase).toBe('review')
  })

  it('无 first_study_date → new；无 next_study_date → last+1 天兜底', () => {
    const noFirst = mapStudyRecord(
      record({ first_study_date: null, last_study_date: formatMaimemoDate(NOW - DAY), next_study_date: null }),
      MATCH,
      NOW,
    )
    expect(noFirst.phase).toBe('new')
    expect(noFirst.dueAt).toBeNull() // new 阶段 dueAt 为 null（§1.2）
    const nothing = mapStudyRecord(
      record({ first_study_date: null, last_study_date: null, next_study_date: null }),
      MATCH,
      NOW,
    )
    expect(nothing.phase).toBe('new')
    expect(nothing.firstSeenAt).toBeNull()
    expect(nothing.dueAt).toBeNull()
  })

  it('日期脏数据不崩溃（退化为 null）', () => {
    const state = mapStudyRecord(
      record({ first_study_date: 'garbage', last_study_date: 'x', next_study_date: 'y' }),
      MATCH,
      NOW,
    )
    expect(state.firstSeenAt).toBeNull()
    expect(state.lastReviewedAt).toBeNull()
    expect(state.dueAt).toBeNull()
    expect(Number.isFinite(state.stability)).toBe(true)
    expect(state.stability).toBeGreaterThan(0)
  })
})

describe('批量映射 mapStudyRecords', () => {
  const wordMatch = new Map<string, MatchedWordInfo>([
    ['embrace', MATCH],
    ['embed', { ...MATCH, wordId: 'test-deck:embed', spelling: 'embed', meaningIds: ['test-deck:embed#M1'] }],
  ])
  const matcher: RecordMatcher = (spelling) => wordMatch.get(normalizeSpelling(spelling)) ?? null

  it('匹配/未匹配/脏数据分别计数', () => {
    const result = mapStudyRecords(
      [
        record(),
        record({ voc_spelling: 'Embed', voc_id: 'voc-2' }),
        record({ voc_spelling: 'not-in-deck', voc_id: 'voc-3' }),
        record({ voc_spelling: 'not-in-deck', voc_id: 'voc-4' }),
        { bad: true },
        null,
        record({ voc_spelling: '' }),
      ],
      matcher,
      NOW,
    )
    expect(result.matched).toBe(2)
    expect(result.states).toHaveLength(2)
    expect(result.unmatchedCount).toBe(2)
    expect(result.unmatched).toEqual(['not-in-deck'])
    expect(result.skipped).toBe(3)
    expect(result.issues.some((issue) => issue.code === 'W_SKIPPED')).toBe(true)
  })

  it('同一 wordId 多条记录取 last_study_date 最新', () => {
    const result = mapStudyRecords(
      [
        record({ last_study_date: formatMaimemoDate(NOW - 5 * DAY), study_count: 1 }),
        record({ last_study_date: formatMaimemoDate(NOW - DAY), study_count: 9 }),
      ],
      matcher,
      NOW,
    )
    expect(result.matched).toBe(1)
    expect(result.states[0]!.reps).toBe(9)
  })

  it('未知 last_response 给 warning 并按未评分处理', () => {
    const result = mapStudyRecords([record({ last_response: 'BRAND_NEW' })], matcher, NOW)
    expect(result.states[0]!.lastRating).toBeNull()
    expect(result.issues.some((issue) => /未知 last_response/.test(issue.message))).toBe(true)
  })

  it('unmatched 列表最多 100 个，但计数完整', () => {
    const records = Array.from({ length: 130 }, (_, index) => record({ voc_spelling: `unknown${index}`, voc_id: `u-${index}` }))
    const result = mapStudyRecords(records, matcher, NOW)
    expect(result.unmatchedCount).toBe(130)
    expect(result.unmatched).toHaveLength(100)
    expect(result.matched).toBe(0)
  })
})
