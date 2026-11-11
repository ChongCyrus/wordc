import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import manifest from '../../src/data/builtin/manifest.json'
import { BRAND } from '../../src/app/brand'
import {
  BUILTIN_DECK_IDS,
  DECK_SOURCES,
  ensureBuiltinDecks,
  findIdRuleViolations,
  getDb,
  getDeckProgress,
  listDecks,
  loadSessionSnapshot,
  parseBuiltinDeckFile,
  resetDatabase,
  saveSessionSnapshot,
} from '../../src/data'
import { createWordState, normalizeHeadword } from '../../src/core'

beforeEach(async () => {
  await resetDatabase()
})

/**
 * task-58：内置词库测试**按配置参数化**（私版受限商业词表+大纲；公开版只有大纲）。
 * - 词数/版本一律从构建产物 manifest.json 读，不在测试里写死 6702/5528；
 * - 只在「对应 deck 存在」时执行该 deck 的专项断言（公开版自动跳过受限商业词表项）。
 */
const SOURCES = [...DECK_SOURCES]
const DECK_IDS = [...BUILTIN_DECK_IDS]
const PRIMARY = BRAND.defaultDeckId
const HONGBAOSHU = SOURCES.find((source) => source.key === 'hongbaoshu')?.deckId
const DAGANG = SOURCES.find((source) => source.key === 'dagang')?.deckId
const hasHong = Boolean(HONGBAOSHU)
const hasDagang = Boolean(DAGANG)
const deckWordCount = (deckId: string): number =>
  manifest.decks.find((deck) => deck.deckId === deckId)?.wordCount ?? 0
const manifestKeyOf = (deckId: string): string =>
  manifest.decks.find((deck) => deck.deckId === deckId)?.key ?? ''

describe('内置词库种子（AC7）', () => {
  it('首次种子按配置写入全部内置词库与词条（默认库读 BRAND）', async () => {
    const result = await ensureBuiltinDecks()
    expect(result.issues).toEqual([])
    expect(result.seeded.sort()).toEqual(DECK_IDS.sort())
    expect(result.decks).toHaveLength(DECK_IDS.length)
    expect(result.decks.map((deck) => deck.id).sort()).toEqual([...DECK_IDS].sort())

    const db = getDb()
    let total = 0
    for (const deckId of DECK_IDS) {
      const expected = deckWordCount(deckId)
      expect(expected, `manifest 缺少 deck ${deckId} 的 wordCount`).toBeGreaterThan(0)
      expect(await db.words.where('deckId').equals(deckId).count()).toBe(expected)
      total += expected
    }
    expect(await db.words.count()).toBe(total)

    // 默认在学词库 = BRAND.defaultDeckId（私版受限商业词表 / 公开版大纲）
    const defaultDeck = result.decks.find((deck) => deck.isDefault)
    expect(defaultDeck?.id).toBe(PRIMARY)
    expect(defaultDeck?.builtinKey).toBeTruthy() // 与 manifest key 对应（具体命名随 deck 而定，公开版单库也成立）
    // 版权/许可必须随词库展示（D20/D30）：不硬编码私版文案，按构建产物 deck 文件的实际 license 断言
    const rawDefaultDeck = JSON.parse(await SOURCES[0]!.load()) as { deck?: { license?: string } }
    expect(defaultDeck?.license?.trim().length).toBeGreaterThan(0)
    expect(defaultDeck?.license).toBe(rawDefaultDeck.deck?.license)
    expect(defaultDeck?.license).toMatch(/CC|版权|许可|license/i)
  }, 120_000)

  it('全部内置词库词条 id 符合 §1.4 且释义非空', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    for (const deckId of DECK_IDS) {
      const words = await db.words.where('deckId').equals(deckId).toArray()
      expect(words.length, `${deckId} 词条数应与 manifest 一致`).toBe(deckWordCount(deckId))
      for (const word of words) {
        expect(word.id.startsWith(`${deckId}:`)).toBe(true)
        expect(word.id).toBe(`${deckId}:${normalizeHeadword(word.headword)}`)
        expect(word.headwordLower).toBe(normalizeHeadword(word.headword))
        expect(word.meanings.length).toBeGreaterThanOrEqual(1)
      }
      expect(findIdRuleViolations(deckId, words)).toEqual([])
    }
  }, 120_000)

  it.skipIf(!hasHong)('受限商业词表：18 条无释义源数据走兜底 + no-meaning 标签', async () => {
    await ensureBuiltinDecks()
    const words = await getDb().words.where('deckId').equals(HONGBAOSHU!).toArray()
    const noMeaning = words.filter((word) => word.tags.includes('no-meaning'))
    expect(noMeaning.length).toBeGreaterThan(0)
    expect(noMeaning.every((word) => word.meanings[0]!.cn === word.headword)).toBe(true)
  }, 120_000)

  it.skipIf(!hasDagang)('大纲词库：含例句/词频/CEFR/分类，大小写变体合并', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const dagang = await db.decks.get(DAGANG!)
    expect(dagang?.wordCount).toBe(deckWordCount(DAGANG!))
    expect(dagang?.source).toBe('builtin')
    // 公开版只内置大纲时它就是默认库；私版默认库是受限商业词表 → 按 BRAND 动态断言
    expect(dagang?.isDefault).toBe(DAGANG === BRAND.defaultDeckId)

    const words = await db.words.where('deckId').equals(DAGANG!).toArray()
    const word = words.find((item) => item.headwordLower === 'the')!
    expect(word.meanings[0]!.cn).toBe('这个、这些')
    expect(word.examples.length).toBeGreaterThan(0)
    expect(word.examples[0]!.cn).toBeTruthy()
    expect(word.frequency).toBeGreaterThan(0)
    expect(word.cefr).toBe('A1')
    expect(word.chapter).toContain('数词')
    const may = words.find((item) => item.headwordLower === 'may')!
    expect(may.meanings.map((meaning) => meaning.cn).join('|')).toContain('五月')
  }, 120_000)

  it.skipIf(!hasHong)('含义按语义拆分（task-16）：embrace 拆出 ≥3 项、单义项不误拆', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const embrace = (await db.words.get(`${HONGBAOSHU}:embrace`))!
    const embraceCns = embrace.meanings.map((meaning) => meaning.cn)
    expect(embraceCns.length).toBeGreaterThanOrEqual(3)
    expect(embraceCns).toContain('拥抱')
    expect(embraceCns).toContain('信奉，皈依')
    expect(embraceCns).toContain('包含')
    expect(embraceCns).not.toContain('拥抱；信奉，皈依；包含')
    // 单义项不误拆（大纲 dog = 「狗」）
    if (hasDagang) {
      const dog = (await db.words.get(`${DAGANG}:dog`))!
      expect(dog.meanings).toHaveLength(1)
      expect(dog.meanings[0]!.cn).toBe('狗')
    }
  }, 120_000)

  it('含义拆分全库约束（1–12 项、cn 非空、无重复、无分号残留）', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    for (const deckId of DECK_IDS) {
      const violations: string[] = []
      let totalMeanings = 0
      const words = await db.words.where('deckId').equals(deckId).toArray()
      for (const word of words) {
        totalMeanings += word.meanings.length
        if (word.meanings.length > 12) violations.push(`${word.id}: ${word.meanings.length} 项 >12`)
        const seen = new Set<string>()
        for (const meaning of word.meanings) {
          if (!meaning.cn.trim()) violations.push(`${word.id}: 空义项`)
          if (/[；;]/.test(meaning.cn)) violations.push(`${word.id}: 分号残留「${meaning.cn}」`)
          if (seen.has(meaning.cn)) violations.push(`${word.id}: 重复义项「${meaning.cn}」`)
          seen.add(meaning.cn)
        }
      }
      expect(violations.slice(0, 20), deckId).toEqual([])
      if (manifestKeyOf(deckId) === 'hongbaoshu') expect(totalMeanings).toBeGreaterThan(20000)
    }
  }, 120_000)

  it('官方难度（Dataverse）：覆盖率达标、范围 1–10、未命中兜底 5；已知词 dog/nose=1', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    for (const deckId of DECK_IDS) {
      const key = manifestKeyOf(deckId)
      const minCoverage = key === 'hongbaoshu' ? 0.98 : 0.99
      const words = await db.words.where('deckId').equals(deckId).toArray()
      const estimated = words.filter((word) => word.tags.includes('difficulty-estimated'))
      expect((words.length - estimated.length) / words.length, deckId).toBeGreaterThanOrEqual(minCoverage)
      expect(words.every((word) => typeof word.difficulty === 'number')).toBe(true)
      expect(
        words.every((word) => word.difficulty! >= 1 && word.difficulty! <= 10),
      ).toBe(true)
      expect(estimated.every((word) => word.difficulty === 5)).toBe(true)
      if (hasHong || hasDagang) {
        const dog = words.find((word) => word.headwordLower === 'dog')
        const nose = words.find((word) => word.headwordLower === 'nose')
        if (dog) expect(dog.difficulty).toBe(1)
        if (nose) expect(nose.difficulty).toBe(1)
      }
    }
  }, 120_000)

  it('词组数据（KyleBing）：各内置词库有足量词组、≤8 条/词、en/cn 非空', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    for (const deckId of DECK_IDS) {
      const minWithPhrases = manifestKeyOf(deckId) === 'hongbaoshu' ? 4000 : 3500
      const words = await db.words.where('deckId').equals(deckId).toArray()
      const withPhrases = words.filter((word) => word.phrases.length > 0)
      expect(withPhrases.length, deckId).toBeGreaterThan(minWithPhrases)
      expect(withPhrases.every((word) => word.phrases.length <= 8)).toBe(true)
      for (const word of withPhrases.slice(0, 100)) {
        for (const phrase of word.phrases) {
          expect(phrase.en.length).toBeGreaterThan(0)
          expect(phrase.cn.length).toBeGreaterThan(0)
        }
      }
    }
  }, 120_000)

  it('幂等：第二次调用直接跳过，不重复写入', async () => {
    const first = await ensureBuiltinDecks()
    expect(first.seeded).toHaveLength(DECK_IDS.length)
    const db = getDb()
    const countBefore = await db.words.count()
    const updatedAtBefore = (await db.decks.get(PRIMARY))!.updatedAt

    const second = await ensureBuiltinDecks()
    expect(second.seeded).toEqual([])
    expect(second.skipped.sort()).toEqual([...DECK_IDS].sort())
    expect(await db.words.count()).toBe(countBefore)
    expect((await db.decks.get(PRIMARY))!.updatedAt).toBe(updatedAtBefore)
    expect(second.decks).toHaveLength(DECK_IDS.length)
  }, 120_000)

  it('并发调用只种子一次（in-flight 合并）', async () => {
    const [a, b] = await Promise.all([ensureBuiltinDecks(), ensureBuiltinDecks()])
    expect(a.seeded.sort()).toEqual([...DECK_IDS].sort())
    expect(b.seeded.sort()).toEqual([...DECK_IDS].sort())
    const expectedTotal = DECK_IDS.reduce((sum, deckId) => sum + deckWordCount(deckId), 0)
    expect(await getDb().words.count()).toBe(expectedTotal)
  }, 120_000)

  it('数据版本升级：重新种子替换词表、保留同 wordId 的 states、清理孤儿 states/session', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const primaryDeck = (await db.decks.get(PRIMARY))!
    const currentVersion = primaryDeck.version
    expect(currentVersion).toBeGreaterThanOrEqual(2)
    const others = DECK_IDS.filter((deckId) => deckId !== PRIMARY)
    const now = Date.now()

    // 模拟「老安装」：默认库版本与 meta 记录都回退一版
    const seededMeta = { ...((await db.meta.get('builtin.seeded'))!.value as Record<string, number>) }
    seededMeta[manifestKeyOf(PRIMARY)] = currentVersion - 1
    await db.meta.put({ key: 'builtin.seeded', value: seededMeta, updatedAt: 0 })
    await db.decks.put({ ...primaryDeck, version: currentVersion - 1 })

    const sampleId = `${PRIMARY}:the`
    const sample = (await db.words.get(sampleId))!
    expect(sample.examples.length).toBeGreaterThan(0) // 新数据本身有例句
    await db.words.put({ ...sample, examples: [] }) // 伪装成旧的无例句词条
    // 已有学习进度（同 wordId）应该保留
    const keptState = createWordState({ wordId: sampleId, deckId: PRIMARY, now })
    await db.states.put({
      ...keptState,
      stability: 123,
      reps: 7,
      // M1 是新数据里仍有效的 meaningId；M99 是旧顺序/旧义项的失效 key，应在重种时清掉
      meaningStats: {
        [`${sampleId}#M1`]: { clicks: 2, encounters: 3 },
        [`${sampleId}#M99`]: { clicks: 9, encounters: 9 },
      },
    })
    await saveSessionSnapshot({
      wordId: sampleId,
      deckId: PRIMARY,
      wcCounts: { [`${sampleId}#M99`]: 2 },
      wcActiveMeaningId: `${sampleId}#M99`,
      stage: 'memory',
      startedAt: now,
      updatedAt: now,
    })
    // 造一个「新版本数据里会被删除」的旧词 + 孤儿 state/session 快照
    const orphanId = `${PRIMARY}:zzz-legacy-word`
    await db.words.put({
      ...sample,
      id: orphanId,
      headword: 'zzzlegacyword',
      headwordLower: 'zzzlegacyword',
      order: 999999,
      examples: [],
    })
    await db.states.put(createWordState({ wordId: orphanId, deckId: PRIMARY, now }))
    await db.meta.put({ key: `session:${orphanId}`, value: { wordId: orphanId }, updatedAt: now })

    const result = await ensureBuiltinDecks()
    expect(result.issues).toEqual([])
    expect(result.seeded).toContain(PRIMARY) // 默认库数据版本变了 → 重新种子
    for (const deckId of others) expect(result.skipped).toContain(deckId) // 其它库版本未变 → 跳过

    const sampleAfter = (await db.words.get(sampleId))!
    expect(sampleAfter.examples.length).toBeGreaterThan(0)
    expect(sampleAfter.examples[0]!.en.length).toBeGreaterThan(0)
    expect(await db.words.where('deckId').equals(PRIMARY).count()).toBe(deckWordCount(PRIMARY))
    expect((await db.decks.get(PRIMARY))!.version).toBe(currentVersion)
    expect(((await db.meta.get('builtin.seeded'))!.value as Record<string, number>)[manifestKeyOf(PRIMARY)]).toBe(
      currentVersion,
    )

    // 同 wordId 的学习进度保留（不被重种子清掉），失效的 meaningStats key 被清理
    const keptAfter = await db.states.get(sampleId)
    expect(keptAfter?.stability).toBe(123)
    expect(keptAfter?.reps).toBe(7)
    expect(keptAfter?.meaningStats[`${sampleId}#M1`]).toEqual({ clicks: 2, encounters: 3 })
    expect(keptAfter?.meaningStats[`${sampleId}#M99`]).toBeUndefined()
    expect(await loadSessionSnapshot(sampleId)).toBeNull()
    // 新数据里不存在的词：词条、孤儿 state、session 快照都被清理
    expect(await db.words.get(orphanId)).toBeUndefined()
    expect(await db.states.get(orphanId)).toBeUndefined()
    expect(await db.meta.get(`session:${orphanId}`)).toBeUndefined()
  }, 180_000)

  it('listDecks 默认词库排第一；getDeckProgress 未学时 newCount=wordCount', async () => {
    await ensureBuiltinDecks()
    const decks = await listDecks()
    expect(decks[0]!.id).toBe(PRIMARY)
    const expected = deckWordCount(PRIMARY)
    const progress = await getDeckProgress(PRIMARY)
    expect(progress.wordCount).toBe(expected)
    expect(progress.studiedCount).toBe(0)
    expect(progress.newCount).toBe(expected)
    expect(progress.progress).toBe(0)
  }, 120_000)
})

describe('内置词库文件解析', () => {
  it('紧凑文件可解析，columns 完整', async () => {
    const source = SOURCES[0]!
    const parsed = parseBuiltinDeckFile(await source.load())
    expect(parsed.deck.id).toBe(source.deckId)
    expect(parsed.words).toHaveLength(deckWordCount(source.deckId))
    expect(parsed.words[0]!.id.startsWith(`${source.deckId}:`)).toBe(true)
    expect(parsed.meta.sourceUrl).toBeTruthy()
  })

  it('非法格式抛错', () => {
    expect(() => parseBuiltinDeckFile('{"format":"other"}')).toThrow()
    expect(() => parseBuiltinDeckFile('{"format":"momo-builtin-deck","formatVersion":9}')).toThrow()
  })
})
