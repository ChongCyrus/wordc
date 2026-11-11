import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { BRAND } from '../../src/app/brand'
import {
  buildDeckFile,
  DECK_SOURCES,
  ensureBuiltinDecks,
  getDb,
  importDeckFile,
  parseDeckFile,
  resetDatabase,
  stableStringify,
} from '../../src/data'

const SOURCES = [...DECK_SOURCES]
const PRIMARY = BRAND.defaultDeckId
const HONGBAOSHU = SOURCES.find((source) => source.key === 'hongbaoshu')?.deckId ?? ''
const hasHong = Boolean(HONGBAOSHU)

/**
 * task-42 实测值（数据不变时保持稳定；改数据/算法后需同步）。
 * 注意：这里按 **loader 去重/≤8 后** 的 Word.phrases 计数；
 * 构建脚本 meta 里是原始计数（hongbaoshu 22488/12127、dagang 22204/8432）。
 */
const EXPECTED: Record<string, { total: number; assigned: number }> = {
  hongbaoshu: { total: 22488, assigned: 12127 },
  dagang: { total: 22196, assigned: 8431 },
}

beforeEach(async () => {
  await resetDatabase()
})

describe('Phrase.meaningId（task-42：词组按含义归属）', () => {
  it('parseDeckFile：可选 meaningId 原样保留；旧数据缺失 = 词级（undefined）', () => {
    const base = {
      format: 'momo-deck',
      formatVersion: 1,
      exportedAt: 1,
      generator: 'test',
      deck: {
        id: 'deck-phrase',
        name: '词组测试',
        source: 'imported',
        wordCount: 2,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      words: [
        {
          headword: 'embrace',
          meanings: [
            { pos: 'n.', cn: '拥抱' },
            { pos: 'vt.', cn: '包含' },
          ],
          phrases: [
            { en: 'warm embrace', cn: '温暖的拥抱', meaningId: 'deck-phrase:embrace#M1' },
            { en: 'embrace a chance', cn: '抓住机会' },
          ],
        },
        { headword: 'legacy', meanings: [{ cn: '旧的' }], phrases: [{ en: 'legacy phrase', cn: '旧词组' }] },
      ],
    }
    const result = parseDeckFile(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const embrace = result.value.words.find((word) => word.headwordLower === 'embrace')!
    expect(embrace.phrases).toHaveLength(2)
    expect(embrace.phrases[0]).toMatchObject({
      en: 'warm embrace',
      cn: '温暖的拥抱',
      meaningId: 'deck-phrase:embrace#M1',
    })
    expect(embrace.phrases[1]!.meaningId).toBeUndefined() // 旧数据/未归属 = 词级
    const legacy = result.value.words.find((word) => word.headwordLower === 'legacy')!
    expect(legacy.phrases[0]!.meaningId).toBeUndefined()
  })

  it('内置词库覆盖率（实测值写死）且归属 id 均合法、每词 ≤8 条', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    for (const source of SOURCES) {
      const deckId = source.deckId
      const expected = EXPECTED[source.key]
      if (!expected) continue
      const words = await db.words.where('deckId').equals(deckId).toArray()
      let total = 0
      let assigned = 0
      const violations: string[] = []
      for (const word of words) {
        if (word.phrases.length > 8) violations.push(`${word.id}: >8 条`)
        const meaningIds = new Set(word.meanings.map((meaning) => meaning.id))
        for (const phrase of word.phrases) {
          total += 1
          if (phrase.meaningId == null) continue
          assigned += 1
          if (!meaningIds.has(phrase.meaningId)) {
            violations.push(`${word.id}: 非法 meaningId ${phrase.meaningId}`)
          }
        }
      }
      expect(violations.slice(0, 10)).toEqual([])
      expect(total).toBe(expected.total)
      expect(assigned).toBe(expected.assigned)
      expect(assigned / total).toBeGreaterThan(0.35) // 实测：受限商业词表 53.9% / 大纲 38.0%
    }
  }, 120_000)

  it.skipIf(!hasHong)('抽样：embrace「温暖的拥抱」→ 拥抱义；act「对…起作用」→ 起作用义；act as 无匹配 → null（不硬猜）', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const embrace = (await db.words.get(`${HONGBAOSHU}:embrace`))!
    const warm = embrace.phrases.find((phrase) => phrase.en === 'warm embrace')!
    expect(warm.cn).toBe('温暖的拥抱')
    expect(warm.meaningId).toBe(`${embrace.id}#M1`)
    expect(embrace.meanings[0]!.cn).toBe('拥抱')

    const act = (await db.words.get(`${HONGBAOSHU}:act`))!
    const actOn = act.phrases.find((phrase) => phrase.en === 'act on')!
    expect(actOn.meaningId).toBe(`${act.id}#M11`)
    expect(act.meanings[10]!.cn).toContain('起作用')
    // "act as / 担当" 与该词各含义没有 ≥2 字中文词重叠 → 保持词级（null），宁可不显示也不乱配
    const actAs = act.phrases.find((phrase) => phrase.en === 'act as')!
    expect(actAs.meaningId).toBeUndefined()
  }, 120_000)

  it('导出→导入（DeckFile）保留 meaningId；迁移包/旧 deck 兼容', async () => {
    await ensureBuiltinDecks()
    // 默认词库中找一条带归属词组的词（私版受限商业词表 / 公开版大纲均可）
    const db = getDb()
    const wordsWithMeaning = await db.words
      .where('deckId')
      .equals(PRIMARY)
      .toArray()
    const sampleWord = wordsWithMeaning.find((word) => word.phrases.some((phrase) => phrase.meaningId != null))!
    expect(sampleWord).toBeTruthy()
    const file = await buildDeckFile(PRIMARY)
    const fromFile = file.words.find((word) => word.id === sampleWord.id)!
    expect(fromFile.phrases.some((phrase) => phrase.meaningId != null)).toBe(true)

    // 导入到空库，meaningId 应原样保留（与导出文件一致）
    await resetDatabase()
    const report = await importDeckFile(stableStringify(file), { strategy: 'replace' })
    expect(report.ok).toBe(true)
    const imported = (await getDb().words.get(sampleWord.id))!
    expect(stableStringify(imported.phrases)).toBe(stableStringify(fromFile.phrases))

    // 旧 deck（无 meaningId）导入不报错，视为词级
    const legacyDeck = {
      format: 'momo-deck',
      formatVersion: 1,
      exportedAt: 1,
      generator: 'legacy',
      deck: { id: 'legacy-phrase-deck', name: '旧词组库', source: 'imported', wordCount: 1, version: 1, createdAt: 1, updatedAt: 1 },
      words: [{ headword: 'kit', meanings: [{ cn: '工具包' }], phrases: [{ en: 'tool kit', cn: '工具包' }] }],
    }
    const legacyReport = await importDeckFile(stableStringify(legacyDeck))
    expect(legacyReport.ok).toBe(true)
    const kit = (await getDb().words.get('legacy-phrase-deck:kit'))!
    expect(kit.phrases).toHaveLength(1)
    expect(kit.phrases[0]!.meaningId).toBeUndefined()
  }, 180_000)
})
