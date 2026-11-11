import '../test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  ensureBuiltinDecks,
  getDb,
  getSettings,
  importMaimemoProgress,
  importMaimemoRecords,
  isMaimemoError,
  mapStudyRecordsToStates,
  parseMaimemoRecordsJson,
  probeMaimemoToken,
  resetDatabase,
  setMaimemoSession,
  updateSettings,
} from '../../../src/data'
import { formatMaimemoDate } from '../../../src/data/api/maimemo-client'
import type { MaimemoClient } from '../../../src/data/api/maimemo-client'
import { initialStability } from '../../../src/core'
import { BRAND } from '../../../src/app/brand'

const PRIMARY = BRAND.defaultDeckId
const DAY = 86_400_000
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime()

async function builtinWords(limit: number) {
  const db = getDb()
  return db.words
    .where('[deckId+order]')
    .between([PRIMARY, -Infinity], [PRIMARY, Infinity])
    .limit(limit)
    .toArray()
}

beforeEach(async () => {
  await resetDatabase()
  await ensureBuiltinDecks()
  setMaimemoSession({ token: '', proxyUrl: '' })
})

describe('importMaimemoRecords：写 WordState（SPEC §7.3 / D43）', () => {
  it('匹配词库的词建 state（不造词、不动词表），未匹配/脏数据进报告', async () => {
    const words = await builtinWords(4)
    const db = getDb()
    const wordsBefore = await db.words.count()
    const records = [
      {
        voc_id: 'voc-embrace',
        voc_spelling: words[0]!.headword,
        first_study_date: formatMaimemoDate(NOW - 10 * DAY),
        last_study_date: formatMaimemoDate(NOW - 2 * DAY),
        next_study_date: formatMaimemoDate(NOW + 3 * DAY),
        last_response: 'FAMILIAR',
        study_count: 6,
        tags: [],
      },
      {
        voc_id: 'voc-2',
        voc_spelling: words[1]!.headword.toUpperCase(),
        first_study_date: formatMaimemoDate(NOW - 30 * DAY),
        last_study_date: formatMaimemoDate(NOW - 1 * DAY),
        next_study_date: formatMaimemoDate(NOW),
        last_response: 'FORGET',
        study_count: 3,
        tags: ['STICKING'],
      },
      {
        voc_id: 'voc-3',
        voc_spelling: words[2]!.headword,
        first_study_date: null,
        last_study_date: null,
        next_study_date: formatMaimemoDate(NOW + 5 * DAY),
        last_response: 'STUDY_RESPONSE_UNSPECIFIED',
        study_count: 1,
        tags: [],
      },
      {
        voc_id: 'voc-4',
        voc_spelling: words[3]!.headword,
        first_study_date: formatMaimemoDate(NOW - 5 * DAY),
        last_study_date: formatMaimemoDate(NOW - 5 * DAY),
        next_study_date: null,
        last_response: 'WELL_FAMILIAR',
        study_count: 20,
        tags: [],
      },
      {
        voc_id: 'voc-miss',
        voc_spelling: 'zzzznotaword',
        last_response: 'FAMILIAR',
      },
      { garbage: true },
    ]

    const result = await importMaimemoRecords(records)
    expect(result.ok).toBe(true)
    expect(result.totalRecords).toBe(6)
    expect(result.matched).toBe(4)
    expect(result.unmatchedCount).toBe(1)
    expect(result.unmatched).toContain('zzzznotaword')
    expect(result.skipped).toBe(1)
    expect(result.pages).toBe(0)

    // 只写 states，不造词
    expect(await db.words.count()).toBe(wordsBefore)
    expect(await db.states.count()).toBe(4)

    const state0 = (await db.states.get(words[0]!.id))!
    expect(state0.importedFrom).toBe('maimemo')
    expect(state0.phase).toBe('review')
    expect(state0.lastRating).toBe('familiar')
    expect(state0.reps).toBe(6)
    expect(state0.dueAt).not.toBeNull()
    expect(state0.meaningStats[words[0]!.meanings[0]!.id]).toEqual({ clicks: 1, encounters: 2 })
    expect((await db.words.get(words[0]!.id))!.maimemoVocId).toBe('voc-embrace')

    const state1 = (await db.states.get(words[1]!.id))!
    expect(state1.phase).toBe('learning') // FORGET 且次日回炉
    expect(state1.difficulty).toBe(8) // STICKING
    expect(state1.lastRating).toBe('forgot')

    const state2 = (await db.states.get(words[2]!.id))!
    expect(state2.phase).toBe('new') // 无 first_study_date
    expect(state2.lastRating).toBeNull()
    expect(state2.stability).toBeCloseTo(initialStability(5), 6)

    const state3 = (await db.states.get(words[3]!.id))!
    expect(state3.phase).toBe('mastered') // WELL_FAMILIAR
    expect(state3.dueAt).toBeNull()

    // 导入结果写入 meta:import:last
    const last = await db.meta.get('import:last')
    expect((last?.value as { kind: string }).kind).toBe('maimemo')
  }, 120_000)

  it('重复导入幂等（同名 state 覆盖，不产生重复行）', async () => {
    const words = await builtinWords(1)
    const records = [
      {
        voc_spelling: words[0]!.headword,
        first_study_date: formatMaimemoDate(NOW - DAY),
        last_study_date: formatMaimemoDate(NOW - DAY),
        next_study_date: formatMaimemoDate(NOW + DAY),
        last_response: 'FAMILIAR',
        study_count: 2,
      },
    ]
    await importMaimemoRecords(records)
    await importMaimemoRecords(records)
    expect(await getDb().states.count()).toBe(1)
  }, 120_000)

  it('mapStudyRecordsToStates 纯映射不写库', async () => {
    const words = await builtinWords(1)
    const mapped = await mapStudyRecordsToStates([{ voc_spelling: words[0]!.headword, last_response: 'VAGUE' }])
    expect(mapped.matched).toBe(1)
    expect(mapped.states[0]!.wordId).toBe(words[0]!.id)
    expect(await getDb().states.count()).toBe(0)
  }, 120_000)
})

describe('手动 JSON 降级（§7.3）', () => {
  it('支持数组 / {records} / {data:{records}} / {data:[]}', () => {
    const record = { voc_spelling: 'apple' }
    expect(parseMaimemoRecordsJson(`[${JSON.stringify(record)}]`)).toHaveLength(1)
    expect(parseMaimemoRecordsJson(JSON.stringify({ records: [record] }))).toHaveLength(1)
    expect(parseMaimemoRecordsJson(JSON.stringify({ data: { records: [record] } }))).toHaveLength(1)
    expect(parseMaimemoRecordsJson(JSON.stringify({ data: [record] }))).toHaveLength(1)
    expect(() => parseMaimemoRecordsJson('not-json')).toThrow()
    try {
      parseMaimemoRecordsJson('{}')
    } catch (error) {
      expect(isMaimemoError(error) && error.code).toBe('E_BAD_INPUT')
    }
  })
})

describe('importMaimemoProgress：鉴权 / 进度回调 / 结果合并', () => {
  it('无 Token → E_NO_TOKEN', async () => {
    await expect(importMaimemoProgress()).rejects.toMatchObject({ code: 'E_NO_TOKEN' })
  }, 60_000)

  it('注入 mock 客户端：拉取记录并导入，透传 pages/onProgress', async () => {
    const words = await builtinWords(2)
    const records = [
      {
        voc_spelling: words[0]!.headword,
        first_study_date: formatMaimemoDate(NOW - 2 * DAY),
        last_study_date: formatMaimemoDate(NOW - 2 * DAY),
        next_study_date: formatMaimemoDate(NOW + 2 * DAY),
        last_response: 'FAMILIAR',
      },
      { voc_spelling: 'not-matched-word', last_response: 'FAMILIAR' },
    ]
    const progressCalls: Array<[number, number]> = []
    const mockClient = {
      fetchAllStudyRecords: async (options?: {
        onProgress?: (done: number, total: number) => void
        spellings?: string[]
      }) => {
        options?.onProgress?.(1, 2)
        options?.onProgress?.(2, 2)
        return {
          records,
          pages: 7,
          total: 2,
          strategy: 'spellings' as const,
          scanned: 2,
          durationMs: 5,
        }
      },
    } as unknown as MaimemoClient

    const result = await importMaimemoProgress({
      client: mockClient,
      onProgress: (done, total) => progressCalls.push([done, total]),
    })
    expect(result.matched).toBe(1)
    expect(result.unmatchedCount).toBe(1)
    expect(result.pages).toBe(7)
    expect(result.totalRecords).toBe(2)
    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ])
    expect(await getDb().states.count()).toBe(1)
  }, 120_000)

  it('从设置读 Token（只存本机）；probe 无 token 报错', async () => {
    await updateSettings({ 'data.maimemoToken': '' })
    expect((await getSettings())['data.maimemoToken']).toBe('')
    await expect(probeMaimemoToken()).rejects.toMatchObject({ code: 'E_NO_TOKEN' })
  }, 60_000)
})
