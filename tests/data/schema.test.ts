import './test-utils'

import { describe, expect, it } from 'vitest'

import {
  computeChecksum,
  findIdRuleViolations,
  fnv1a64Hex,
  normalizeWordRecord,
  parseDeckFile,
  parseMigrationFile,
  sha256Hex,
  stableStringify,
  verifyChecksum,
  buildWord,
  parseMeaningString,
} from '../../src/data'

describe('stableStringify / checksum（SPEC §1.1 / §6.2）', () => {
  it('对象 key 递归排序、无空白、数组保持顺序', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}')
    expect(stableStringify({ z: undefined, a: 1 })).toBe('{"a":1}')
    expect(stableStringify([undefined, null, { b: 1, a: 2 }])).toBe('[null,null,{"a":2,"b":1}]')
    expect(stableStringify('中文"引号"')).toBe('"中文\\"引号\\""')
  })

  it('SHA-256 与 FNV-1a 64 都可用；verify 两者都认', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    // FNV-1a 64 空串 = offset basis
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325')

    const sha = await computeChecksum('hello')
    expect(sha.algo).toBe('sha256')
    expect((await verifyChecksum('hello', sha.hex)).ok).toBe(true)
    const fnv = fnv1a64Hex('hello')
    expect((await verifyChecksum('hello', fnv)).matchedAlgo).toBe('fnv1a64')
    expect((await verifyChecksum('hello', 'deadbeef')).ok).toBe(false)
  })
})

describe('释义串解析 / Word 工厂（SPEC §1.3 / §1.4）', () => {
  it('parseMeaningString 提取词性并按行拆分', () => {
    expect(parseMeaningString('n. 拥抱\nvt. 拥抱；信奉，皈依；包含\nvi. 拥抱')).toEqual([
      { pos: 'n.', cn: '拥抱' },
      { pos: 'vt.', cn: '拥抱；信奉，皈依；包含' },
      { pos: 'vi.', cn: '拥抱' },
    ])
    expect(parseMeaningString('n.&vt. 言行')).toEqual([{ pos: 'n.&vt.', cn: '言行' }])
    expect(parseMeaningString('')).toEqual([])
    expect(parseMeaningString('n.   \n')).toEqual([])
  })

  it('buildWord 归一化 id / headwordLower / 释义兜底', () => {
    const word = buildWord(
      { headword: '  Ice   Cream ', meanings: [{ cn: '冰淇淋' }, { cn: '冰淇淋' }] },
      'deck-x',
      { order: 1, createdAt: 100 },
    )
    expect(word.headword).toBe('Ice Cream')
    expect(word.id).toBe('deck-x:ice cream')
    expect(word.meanings).toEqual([{ id: 'deck-x:ice cream#M1', cn: '冰淇淋' }])
    expect(word.order).toBe(1)

    const noMeaning = buildWord({ headword: 'zzzz' }, 'deck-x')
    expect(noMeaning.meanings[0]!.cn).toBe('zzzz')
    expect(noMeaning.tags).toContain('no-meaning')
  })

  it('normalizeWordRecord 保留迁移包 id（state 对齐）', () => {
    const { word } = normalizeWordRecord(
      {
        id: 'deck-k:apple',
        headword: 'apple',
        meanings: [{ id: 'deck-k:apple#M1', pos: 'n.', cn: '苹果' }],
        createdAt: 5,
      },
      'deck-k',
      0,
      { preserveIds: true, now: 1 },
    )
    expect(word.id).toBe('deck-k:apple')
    expect(word.meanings[0]!.id).toBe('deck-k:apple#M1')
  })
})

describe('DeckFile 校验与规范化（§6.4）', () => {
  const validRaw = {
    format: 'momo-deck',
    formatVersion: 1,
    exportedAt: 1,
    generator: 'test',
    deck: {
      id: 'deck-test',
      name: '测试词库',
      source: 'imported',
      wordCount: 99,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    words: [
      { headword: 'Apple', meanings: [{ pos: 'n.', cn: '苹果' }] },
      { headword: 'apple', meanings: [{ cn: '苹果公司' }] },
      { term: 'banana', meaning: 'n. 香蕉' },
    ],
  }

  it('缺 id/order 自动生成；大小写重复合并；wordCount 修正', () => {
    const result = parseDeckFile(validRaw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { deck, words, issues } = result.value
    expect(words).toHaveLength(2)
    expect(deck.wordCount).toBe(2)
    expect(words.map((word) => word.id).sort()).toEqual(['deck-test:apple', 'deck-test:banana'])
    const apple = words.find((word) => word.headwordLower === 'apple')!
    expect(apple.meanings[0]).toEqual({ id: 'deck-test:apple#M1', pos: 'n.', cn: '苹果' })
    expect(issues.some((issue) => issue.code === 'W_SKIPPED')).toBe(true) // 重复词条
    expect(findIdRuleViolations('deck-test', words)).toEqual([])
  })

  it('错 format / 版本 / 坏字段 → 结构化错误', () => {
    const wrongFormat = parseDeckFile({ ...validRaw, format: 'x' })
    expect(wrongFormat.ok).toBe(false)
    expect(wrongFormat.issues[0]!.code).toBe('E_FORMAT')

    const wrongVersion = parseDeckFile({ ...validRaw, formatVersion: 2 })
    expect(wrongVersion.ok).toBe(false)
    expect(wrongVersion.issues[0]!.code).toBe('E_VERSION')

    const badDeck = parseDeckFile({ ...validRaw, deck: { id: '', name: '' } })
    expect(badDeck.ok).toBe(false)
    expect(badDeck.issues.some((issue) => issue.code === 'E_FIELD' && issue.path?.startsWith('deck'))).toBe(
      true,
    )
  })
})

describe('MigrationFile 校验', () => {
  it('坏 phase / 缺字段 → E_FIELD（带 path）', () => {
    const base = {
      format: 'momo-migration',
      formatVersion: 1,
      exportedAt: 1,
      generator: 'test',
      appVersion: '0.1.0',
      dataVersion: 1,
      counts: { decks: 1, words: 1, states: 1, reviewLogs: 0 },
      checksum: 'x',
      data: {
        decks: [
          {
            id: 'deck-k',
            name: 'k',
            source: 'imported',
            wordCount: 1,
            version: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        words: [{ id: 'deck-k:apple', deckId: 'deck-k', headword: 'apple' }],
        states: [
          {
            wordId: 'deck-k:apple',
            deckId: 'deck-k',
            phase: 'broken-phase',
            stability: 1,
            difficulty: 1,
            reps: 0,
            lapses: 0,
            firstSeenAt: null,
            lastReviewedAt: null,
            dueAt: null,
            nextIntervalDays: 1,
            retrievability: 1,
            lastRating: null,
            sameDayCount: 0,
            sameDayDate: '',
            meaningStats: {},
            sameDayRequeued: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        reviewLogs: [],
        settings: [],
      },
    }
    const result = parseMigrationFile(base)
    expect(result.ok).toBe(false)
    const issue = result.issues.find((item) => item.code === 'E_FIELD')
    expect(issue?.path).toContain('data.states[0].phase')
  })

  it('格式/版本错误先报 E_FORMAT / E_VERSION', () => {
    expect(parseMigrationFile({ format: 'x' }).issues[0]!.code).toBe('E_FORMAT')
    expect(
      parseMigrationFile({ format: 'momo-migration', formatVersion: 2, dataVersion: 2 }).issues[0]!.code,
    ).toBe('E_VERSION')
  })
})
