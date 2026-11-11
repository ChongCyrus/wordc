import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  addDays,
  dayDiff,
  daysBetween,
  fnv1a32,
  isSameLocalDay,
  isWordIdOfDeck,
  localDateKey,
  meaningIdOf,
  newDeckId,
  normalizeHeadword,
  startOfLocalDay,
  wordIdOf,
  wordIdOfMeaning,
  headwordOfWordId,
} from '../../src/core'
import { localMidnight } from './helpers'

const DECK = 'test-deck'

describe('core/ids · id 规则（SPEC §1.4，必须一致）', () => {
  it('normalizeHeadword：去空白、合并连续空白、小写', () => {
    expect(normalizeHeadword('  Internet ')).toBe('internet')
    expect(normalizeHeadword('give   up')).toBe('give up')
    expect(normalizeHeadword('Embrace\n\t')).toBe('embrace')
    expect(normalizeHeadword('')).toBe('')
  })

  it('wordIdOf = `${deckId}:${normalizedHeadword}`', () => {
    expect(wordIdOf(DECK, 'Embrace')).toBe('test-deck:embrace')
    expect(wordIdOf(DECK, '  Embrace  ')).toBe('test-deck:embrace')
  })

  it('meaningIdOf：数组下标 1 起，`${wordId}#M${i}`', () => {
    const wid = wordIdOf(DECK, 'embrace')
    expect(meaningIdOf(wid, 1)).toBe('test-deck:embrace#M1')
    expect(meaningIdOf(wid, 3)).toBe('test-deck:embrace#M3')
  })

  it('newDeckId：ASCII 名称直接用；中文名生成 deck-<base36> 且稳定', () => {
    expect(newDeckId('my-deck')).toBe('my-deck')
    expect(newDeckId('MyDeck')).toMatch(/^deck-[a-z0-9]+$/)
    const created = 1_762_790_000_000
    expect(newDeckId('我的词单', created)).toBe(newDeckId('我的词单', created))
    expect(newDeckId('我的词单', created)).not.toBe(newDeckId('我的词单', created + 1))
  })

  it('fnv1a32：确定性、32 位无符号、不同输入大概率不同', () => {
    expect(fnv1a32('embrace')).toBe(fnv1a32('embrace'))
    expect(fnv1a32('embrace')).not.toBe(fnv1a32('embraces'))
    for (const s of ['', 'a', 'abc', '考研', 'give up']) {
      const h = fnv1a32(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('辅助解析：isWordIdOfDeck / headwordOfWordId / wordIdOfMeaning', () => {
    expect(isWordIdOfDeck(`${DECK}:embrace`, DECK)).toBe(true)
    expect(isWordIdOfDeck('other:embrace', DECK)).toBe(false)
    expect(headwordOfWordId(`${DECK}:give up`)).toBe('give up')
    expect(wordIdOfMeaning(`${DECK}:embrace#M2`)).toBe(`${DECK}:embrace`)
  })
})

describe('core/time · 本地日期边界（时区正确性）', () => {
  it('localDateKey 用本地时区（深夜仍是当天）', () => {
    expect(localDateKey(localMidnight(2026, 11, 10))).toBe('2026-11-10')
    expect(localDateKey(localMidnight(2026, 11, 10) + 23 * 3_600_000 + 59 * 60_000)).toBe('2026-11-10')
    expect(localDateKey(localMidnight(2026, 11, 11))).toBe('2026-11-11')
    expect(localDateKey(localMidnight(2026, 1, 5))).toBe('2026-01-05')
  })

  it('startOfLocalDay 返回本地 00:00', () => {
    const noon = localMidnight(2026, 11, 10) + 12 * 3_600_000
    expect(startOfLocalDay(noon)).toBe(localMidnight(2026, 11, 10))
    expect(startOfLocalDay(localMidnight(2026, 11, 10))).toBe(localMidnight(2026, 11, 10))
  })

  it('addDays 按日历天推进（跨月/跨年/负数）', () => {
    expect(localDateKey(addDays(localMidnight(2026, 11, 10), 1))).toBe('2026-11-11')
    expect(localDateKey(addDays(localMidnight(2026, 12, 31), 1))).toBe('2027-01-01')
    expect(localDateKey(addDays(localMidnight(2026, 3, 1), -1))).toBe('2026-02-28')
    expect(localDateKey(addDays(localMidnight(2026, 11, 10), 365))).toBe('2027-11-10')
  })

  it('dayDiff 按本地日期差；daysBetween 按毫秒直算', () => {
    const a = localMidnight(2026, 11, 10)
    expect(dayDiff(localMidnight(2026, 11, 12), a)).toBe(2)
    expect(dayDiff(a, localMidnight(2026, 11, 12))).toBe(-2)
    expect(daysBetween(a + DAY_MS, a)).toBe(1)
    expect(daysBetween(a + DAY_MS / 2, a)).toBe(0.5)
    expect(isSameLocalDay(a, a + 3_600_000)).toBe(true)
    expect(isSameLocalDay(a, a + DAY_MS)).toBe(false)
  })
})
