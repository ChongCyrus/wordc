/**
 * QA task-11 · 数据层健壮性 + AC5/AC6/AC7 独立验收（不依赖 dev-data 的测试工具类）。
 *
 * 覆盖：
 *  - AC7：内置两词库条数 6702/5528、默认词库 isDefault、版权字段、学习队列默认取受限商业词表、
 *         `ensureBuiltinDecks` 幂等、**清库后可从种子恢复**。
 *  - 数据健壮性：空词库、重复单词（DeckFile/CSV）、5000 词大库导入性能、
 *         坏 JSON / 空 CSV / 非法 DeckFile 的拒绝行为。
 *  - AC5 补充：replace 导入时的 isDefault 唯一性、导出包 token 过滤、空迁移包。
 *  - AC4（数据层）：**36 个设置 key**（SPEC-v2 §3.5 + task-47/51 + F4/weighted + task-70 AI：v1 15 项 + study.labelSwitch /
 *    memory.showPredictedInterval / study.allowVagueComplete / study.newWordOrder / study.dailyReviewCap）全部持久化 + clamp 边界；
 *    task-47 默认值：showPhrases=true、newWordOrder=random；task-51：dailyReviewCap=0（不限）。
 */

// ⚠️ 必须第一个 import：Node 环境需要 fake-indexeddb 提供全局 indexedDB
import 'fake-indexeddb/auto'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDeckFile,
  buildMigrationFile,
  clearAllData,
  createDeck,
  ensureBuiltinDecks,
  exportMigration,
  getDeck,
  getDeckProgress,
  getDb,
  getSettings,
  getTodayQueue,
  getWordsPage,
  importCsv,
  importDeckFile,
  importMigration,
  listDecks,
  resetDatabase,
  normalizeSettingValue,
  SETTINGS_DEFAULTS,
  SETTING_KEYS,
  settingOrDefault,
  stableStringify,
  updateSettings,
} from '../../src/data'
import type { RawWordInput } from '../../src/data'

const HONGBAOSHU = 'kaoyan-2027-dagang'
const DAGANG = 'kaoyan-2027-dagang'

// ============================================================ 工具（本文件自建，不 import dev-data 的 test-utils）

function makeWordInput(index: number): RawWordInput {
  return {
    headword: `qa-word-${index}`,
    meanings: [
      { pos: 'n.', cn: `测试含义${index}` },
      { pos: 'vt.', cn: `测试动词${index}` },
    ],
    order: index,
  }
}

/**
 * 构造「导入文件」形状（不要求是严格 Word[]：DeckFile 的 words 是宽松 raw 形状，
 * importDeckFile 会经 parseDeckFile 补 id/headwordLower，所以这里只给 RawWordInput）。
 */
interface DeckFileDraft {
  format: 'momo-deck'
  formatVersion: 1
  exportedAt: number
  generator: string
  deck: {
    id: string
    name: string
    source: string
    wordCount: number
    version: number
    createdAt: number
    updatedAt: number
    [key: string]: unknown
  }
  words: RawWordInput[]
  meta: { wordCount: number }
}

function makeDeckFile(
  words: RawWordInput[],
  overrides: Partial<DeckFileDraft['deck']> = {},
): DeckFileDraft {
  return {
    format: 'momo-deck',
    formatVersion: 1,
    exportedAt: 1762790000000,
    generator: 'qa-test',
    deck: {
      id: 'qa-deck',
      name: 'QA 测试词库',
      source: 'custom',
      wordCount: words.length,
      version: 1,
      createdAt: 1762790000000,
      updatedAt: 1762790000000,
      ...overrides,
    },
    words,
    meta: { wordCount: words.length },
  }
}

// ============================================================ AC7

describe('AC7 · 内置词库独立验收', () => {
  beforeAll(async () => {
    await resetDatabase()
    const result = await ensureBuiltinDecks()
    expect(result.issues).toEqual([])
  }, 120_000)

  it('两词库条数 6702 / 5528，默认词库=受限商业词表，来源与许可字段完整', async () => {
    const decks = await listDecks()
    expect(decks.map((deck) => deck.id).sort()).toEqual([DAGANG, HONGBAOSHU].sort())

    const hongbaoshu = await getDeck(HONGBAOSHU)
    const dagang = await getDeck(DAGANG)
    expect(hongbaoshu).not.toBeNull()
    expect(dagang).not.toBeNull()
    expect(hongbaoshu!.wordCount).toBe(6702)
    expect(dagang!.wordCount).toBe(5528)
    expect(hongbaoshu!.isDefault).toBe(true)
    expect(dagang!.isDefault).toBe(false)
    // 默认词库排第一（listDecks 排序契约）
    expect(decks[0]!.id).toBe(HONGBAOSHU)

    const db = getDb()
    expect(await db.words.where('deckId').equals(HONGBAOSHU).count()).toBe(6702)
    expect(await db.words.where('deckId').equals(DAGANG).count()).toBe(5528)
    // 实际词条数 == deck.wordCount（数据一致性）
    expect(hongbaoshu!.wordCount).toBe(6702)
    expect(dagang!.wordCount).toBe(5528)

    // 版权/许可（D20/D21/D30）：默认受限商业词表必须带版权说明；大纲必须带 CC BY-NC-SA 许可
    expect(hongbaoshu!.license ?? '').toContain('版权')
    expect(hongbaoshu!.license ?? '').toContain('请勿分发')
    expect(dagang!.license ?? '').toContain('CC BY-NC-SA')
  }, 120_000)

  it('学习队列默认从受限商业词表取词（selectedDeckId 默认值）', async () => {
    const settings = await getSettings()
    expect(settings['data.selectedDeckId']).toBe(HONGBAOSHU)
    const queue = await getTodayQueue({ now: new Date(2026, 10, 10, 12).getTime() })
    expect(queue.newQueue.length).toBeGreaterThan(0)
    const db = getDb()
    const first = await db.words.get(queue.newQueue[0]!.wordId)
    expect(first?.deckId).toBe(HONGBAOSHU)
  })

  it('ensureBuiltinDecks 幂等：第二次调用 skipped=2、不重复写词条', async () => {
    const before = await getDb().words.count()
    const result = await ensureBuiltinDecks()
    expect(result.seeded).toEqual([])
    expect(result.skipped.sort()).toEqual([DAGANG, HONGBAOSHU].sort())
    expect(await getDb().words.count()).toBe(before)
  })

  it('清空 IndexedDB 后 ensureBuiltinDecks 可恢复两个内置词库（幂等重种）', async () => {
    await clearAllData()
    expect(await getDb().decks.count()).toBe(0)
    expect(await getDb().words.count()).toBe(0)
    expect(await getDb().meta.count()).toBe(0)

    const result = await ensureBuiltinDecks()
    expect(result.issues).toEqual([])
    expect(result.seeded.sort()).toEqual([DAGANG, HONGBAOSHU].sort())

    const decks = await listDecks()
    expect(decks).toHaveLength(2)
    const hongbaoshu = await getDeck(HONGBAOSHU)
    expect(hongbaoshu!.wordCount).toBe(6702)
    expect(hongbaoshu!.isDefault).toBe(true)
    // 恢复后 selectedDeckId 必须仍指向存在的词库
    const settings = await getSettings()
    expect([HONGBAOSHU, DAGANG]).toContain(settings['data.selectedDeckId'])
  }, 240_000)
})

// ============================================================ 数据健壮性

describe('数据健壮性 · 空词库 / 重复单词 / 坏数据', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('空词库：创建→导出→重新导入均可，进度 0、分页 total=0（不出现 NaN）', async () => {
    const deck = await createDeck({ name: '空词库', words: [] })
    expect(deck.wordCount).toBe(0)

    const progress = await getDeckProgress(deck.id)
    expect(progress.wordCount).toBe(0)
    expect(progress.newCount).toBe(0)
    expect(progress.progress).toBe(0)
    expect(Number.isNaN(progress.progress)).toBe(false)

    const page = await getWordsPage(deck.id, { offset: 0, limit: 20 })
    expect(page.total).toBe(0)
    expect(page.words).toEqual([])

    // 首页/队列不能因空词库崩
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const queue = await getTodayQueue({ now: Date.now() })
    expect(queue.newQueue).toEqual([])

    const file = await buildDeckFile(deck.id)
    expect(file.words).toEqual([])
    expect(file.deck.wordCount).toBe(0)
    // 空词库文件重新导入（replace）应成功且词数 0
    const report = await importDeckFile(JSON.stringify(makeDeckFile([], { id: deck.id, name: '空词库' })))
    expect(report.ok).toBe(true)
    expect(report.counts.words).toBe(0)
    expect((await getDeck(deck.id))!.wordCount).toBe(0)
  })

  it('重复单词：DeckFile 内 headword 大小写/空白重复 → 按 id 去重 + W_SKIPPED 警告', async () => {
    const file = makeDeckFile([
      { headword: 'apple', meanings: [{ cn: '苹果' }] },
      { headword: 'Apple', meanings: [{ cn: '苹果2' }] },
      { headword: '  apple  ', meanings: [{ cn: '苹果3' }] },
      { headword: 'banana', meanings: [{ cn: '香蕉' }] },
    ])
    const report = await importDeckFile(JSON.stringify(file))
    expect(report.ok).toBe(true)
    expect(report.counts.words).toBe(2) // apple(首次) + banana
    expect(report.issues.some((issue) => issue.code === 'W_SKIPPED')).toBe(true)
    const words = await getDb().words.where('deckId').equals('qa-deck').toArray()
    expect(words).toHaveLength(2)
    expect(words.map((word) => word.headwordLower).sort()).toEqual(['apple', 'banana'])
  })

  it('重复单词：CSV 同 headword 多行按 cn 合并为一条，不算重复导入', async () => {
    const csv = [
      'headword,pos,meaning',
      'apple,n.,苹果',
      'Apple,n.,苹果；苹果公司',
      'banana,n.,香蕉',
    ].join('\n')
    const report = await importCsv(csv, 'CSV 去重库')
    expect(report.ok).toBe(true)
    expect(report.counts.words).toBe(2)
    const decks = await listDecks()
    const target = decks.find((deck) => deck.name === 'CSV 去重库')!
    const words = await getDb().words.where('deckId').equals(target.id).toArray()
    expect(words).toHaveLength(2)
    const apple = words.find((word) => word.headwordLower === 'apple')!
    // 同 headword 多行合并（按 cn 去重）
    expect(apple.meanings.length).toBe(2)
  })

  it('坏 JSON / 空 CSV / 缺 format 的 DeckFile → 结构化错误且不写库', async () => {
    const before = await getDb().decks.count()

    const badJson = await importDeckFile('{ not json')
    expect(badJson.ok).toBe(false)
    expect(badJson.issues[0]!.code).toBe('E_FORMAT')

    const notDeck = await importDeckFile(JSON.stringify({ hello: 'world' }))
    expect(notDeck.ok).toBe(false)
    expect(notDeck.issues[0]!.code).toBe('E_FORMAT')

    // 空 CSV（只有表头、0 数据行）→ E_FIELD 拒绝且不建库（QA-02，dev-data 已修）
    const emptyCsvReport = await importCsv('headword,pos,meaning\n', '空 CSV 库')
    expect(emptyCsvReport.ok).toBe(false)
    expect(emptyCsvReport.issues.some((issue) => issue.level === 'error' && issue.code === 'E_FIELD')).toBe(true)
    expect(emptyCsvReport.counts.words).toBe(0)
    expect(await getDb().decks.count()).toBe(before)
  })

  it('5000 词大库 importDeckFile 性能（记录耗时；<15s 视为可接受）', async () => {
    const words = Array.from({ length: 5000 }, (_, i) => makeWordInput(i + 1))
    const file = makeDeckFile(words, { id: 'qa-deck-5000', name: 'QA 5000 词' })
    const raw = JSON.stringify(file)
    const started = Date.now()
    const report = await importDeckFile(raw, { strategy: 'replace' })
    const durationMs = Date.now() - started
    // 打印给 QA.md 记录（fake-indexeddb 环境，手机真实 IndexedDB 会更慢些）
    console.log(`[perf] 5000 词 importDeckFile: ${durationMs}ms, 文件 ${(raw.length / 1024).toFixed(0)}KB`)
    expect(report.ok).toBe(true)
    expect(report.counts.words).toBe(5000)
    expect(await getDb().words.where('deckId').equals('qa-deck-5000').count()).toBe(5000)
    expect(durationMs).toBeLessThan(15_000)
  }, 60_000)
})

// ============================================================ AC5 补充

describe('AC5 补充 · 导出包隐私 / isDefault 唯一性 / 空备份', () => {
  beforeEach(async () => {
    await resetDatabase()
    await ensureBuiltinDecks()
  }, 240_000)

  it('迁移包不含 data.maimemoToken（隐私红线 D23），settings 其余项完整', async () => {
    await updateSettings({ 'data.maimemoToken': 'secret-token-should-not-export', 'study.dailyGoal': 66 })
    const file = await buildMigrationFile()
    expect(file.data.settings.some((row) => row.key === 'data.maimemoToken')).toBe(false)
    const goal = file.data.settings.find((row) => row.key === 'study.dailyGoal')
    expect(goal?.value).toBe(66)
    // 序列化后同样不得出现 token 值
    expect(stableStringify(file).includes('secret-token-should-not-export')).toBe(false)
  })

  // QA-01（已由 dev-data 修复 2026-11-10 23:1x）：importDeckFile/importMigration 导入后调用
  // ensureSingleDefaultDeck() 归一，保证 isDefault 全局唯一（DATA-API §5.2）。
  it('QA-01 回归：导入 isDefault=true 的 DeckFile 后全库只有 1 个默认词库（保留本机默认）', async () => {
    const file = makeDeckFile([{ headword: 'aaa', meanings: [{ cn: '甲' }] }], {
      id: 'qa-default-deck',
      name: '自造默认库',
      isDefault: true,
    })
    const report = await importDeckFile(JSON.stringify(file))
    expect(report.ok).toBe(true)
    const decks = await listDecks()
    const defaults = decks.filter((deck) => deck.isDefault)
    expect(defaults, `默认词库数量=${defaults.length}: ${defaults.map((d) => d.id).join(',')}`).toHaveLength(1)
    // 修复契约：优先保留本机导入前已有的默认词库
    expect(defaults[0]!.id).toBe(HONGBAOSHU)
    expect((await getDeck('qa-default-deck'))!.isDefault).not.toBe(true)
  })

  it('空备份（无词库/状态）导出→导入不崩，selectedDeckId 兜底有效', async () => {
    await clearAllData()
    const blob = await exportMigration()
    const text = await blob.text()
    const file = JSON.parse(text) as { data: { decks: unknown[] }; counts: Record<string, number> }
    expect(file.data.decks).toEqual([])
    expect(file.counts.decks).toBe(0)

    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok).toBe(true)
    // 空库导入后 settings 行被清空，getSettings 回落到默认值 'kaoyan-2027-dagang'（此时该词库不存在）。
    // 这是「清库后需重新 ensureBuiltinDecks」的文档化用法，后续 ensure 后必须能解析到真实词库。
    const settings = await getSettings()
    expect(typeof settings['data.selectedDeckId']).toBe('string')
    const restored = await ensureBuiltinDecks()
    expect(restored.seeded).toHaveLength(2)
    const afterSettings = await getSettings()
    expect(await getDeck(afterSettings['data.selectedDeckId'])).not.toBeNull()
  }, 240_000)
})

// ============================================================ AC4 数据层

describe('AC4（数据层）· 36 个设置 key 全量持久化与 clamp 边界', () => {
  beforeEach(async () => {
    await resetDatabase()
    const deck = await createDeck('设置测试库')
    await updateSettings({ 'data.selectedDeckId': deck.id })
  })

  it('SETTING_KEYS 恰好 36 个；task-47 默认 showPhrases=true / newWordOrder=random；task-51 dailyReviewCap=0', async () => {
    const expected = [
      // —— v1 的 15 项（SPEC §5）——
      'study.dailyGoal',
      'study.recallMode',
      'board.exampleCount',
      'board.showPhonetic',
      'board.showMeaningPhrases', // F4：白板 per-c 释义显示
      'derivation.markdown', // F10：引申图 Markdown 渲染（默认开）
      'memory.totalRepeats',
      'memory.weightedMin',
      'memory.weightedMax',
      'memory.weightedK',
      'memory.mode',
      'memory.showPhrases', // task-47：默认 true（默认显示词组，覆盖旧 D47 的 false）
      'memory.fontScale',
      'memory.cardSize',
      'app.fontScale',
      'app.theme',
      'app.reduceMotion',
      'data.maimemoToken',
      'data.proxyUrl',
      'data.selectedDeckId',
      // —— v2 新增 3 项（SPEC-v2 §3.5 / task-27）——
      'study.labelSwitch', // 新词首次「认识/不确定/不认识」→ 之后「认识/模糊/忘记」
      'study.allowVagueComplete', // 官方默认不允许模糊完成当日复习
      'memory.showPredictedInterval', // 三键副标题显示「N 天后 / 今日进度%」
      'study.newWordOrder', // task-47：新词顺序 order|random，默认 random（稳定种子乱序）
      'study.dailyReviewCap', // task-51：每日复习上限 0=不限，范围 0–9999
      // —— task-70/80：AI 内容生成 + jsonMode（默认关）——
      'ai.enabled',
      'ai.provider',
      'ai.baseUrl',
      'ai.model',
      'ai.apiKey',
      'ai.keyStorage',
      'ai.transport',
      'ai.batchSize',
      'ai.maxCostPerRun',
      'ai.pregenBudget',
      'ai.jsonMode',
    ]
    expect([...SETTING_KEYS].sort()).toEqual([...expected].sort())
    expect(Object.keys(SETTINGS_DEFAULTS)).toHaveLength(36)
    // v2 新增项默认值（SPEC-v2 §3.5）
    expect(SETTINGS_DEFAULTS['study.labelSwitch']).toBe(true)
    expect(SETTINGS_DEFAULTS['study.allowVagueComplete']).toBe(false)
    expect(SETTINGS_DEFAULTS['memory.showPredictedInterval']).toBe(true)
    // task-47（用户拍板）+ v1 关键默认值
    expect(SETTINGS_DEFAULTS['memory.showPhrases']).toBe(true) // task-47：默认显示词组
    expect(SETTINGS_DEFAULTS['study.newWordOrder']).toBe('random') // task-47：新词默认乱序
    expect(SETTINGS_DEFAULTS['study.dailyReviewCap']).toBe(0) // task-51：默认不限
    // F4 / weighted（0.3.35+）
    expect(SETTINGS_DEFAULTS['board.showMeaningPhrases']).toBe(false)
    expect(SETTINGS_DEFAULTS['derivation.markdown']).toBe(true)
    expect(SETTINGS_DEFAULTS['memory.weightedMin']).toBe(1)
    expect(SETTINGS_DEFAULTS['memory.weightedMax']).toBe(10)
    expect(SETTINGS_DEFAULTS['memory.weightedK']).toBe(1)
    expect(SETTINGS_DEFAULTS['ai.enabled']).toBe(false)
    // 枚举 key 非法值兜底：normalize → undefined；settingOrDefault → 默认 random
    expect(normalizeSettingValue('study.newWordOrder', 'bad')).toBeUndefined()
    expect(settingOrDefault('study.newWordOrder', 'bad')).toBe('random')
    expect(normalizeSettingValue('study.newWordOrder', 'order')).toBe('order')
    expect(settingOrDefault('study.newWordOrder', undefined)).toBe('random')
    expect(SETTINGS_DEFAULTS['study.dailyGoal']).toBe(30)
    expect(SETTINGS_DEFAULTS['memory.totalRepeats']).toBe(3)
    expect(SETTINGS_DEFAULTS['memory.mode']).toBe('sequential')
    expect(SETTINGS_DEFAULTS['app.theme']).toBe('system')
  })

  it('19 个 key 全部写入后读回一致（含 task-47 新 key / token / proxyUrl / selectedDeckId），刷新不丢', async () => {
    const deck = (await listDecks())[0]!
    const patch = {
      'study.dailyGoal': 88,
      'study.recallMode': 'en2cn' as const,
      'study.labelSwitch': false,
      'study.allowVagueComplete': true,
      'board.exampleCount': 3,
      'board.showPhonetic': false,
      'memory.totalRepeats': 7,
      'memory.mode': 'random' as const,
      'memory.showPhrases': true,
      'memory.showPredictedInterval': false,
      'study.newWordOrder': 'order' as const,
      'study.dailyReviewCap': 50,
      'memory.fontScale': 1.25,
      'memory.cardSize': 1.2,
      'app.fontScale': 1.1,
      'app.theme': 'dark' as const,
      'app.reduceMotion': true,
      'data.maimemoToken': 'tk-abc',
      'data.proxyUrl': 'http://127.0.0.1:9999',
      'data.selectedDeckId': deck.id,
    }
    await updateSettings(patch)
    const readBack = await getSettings()
    for (const [key, value] of Object.entries(patch)) {
      expect(readBack[key as keyof typeof patch], key).toBe(value)
    }
    // 重新 getDb（模拟页面重载）后仍在
    const db = getDb()
    expect(await db.settings.count()).toBeGreaterThanOrEqual(20)
  })

  it('数字型 key 边界（v2）：dailyGoal 越界/非整数/非 number → 拒绝；其余数字键 clamp 后写回', async () => {
    // v2（task-27）：dailyGoal 范围 1–9999，越界/小数/字符串 → throw（不再 clamp 到 5–200）
    for (const bad of [0, 10000, 1.5, '30', Number.NaN]) {
      await expect(updateSettings({ 'study.dailyGoal': bad as never }), `dailyGoal=${String(bad)}`).rejects.toThrow()
    }
    await updateSettings({ 'study.dailyGoal': 1 })
    expect((await getSettings())['study.dailyGoal']).toBe(1)
    await updateSettings({ 'study.dailyGoal': 9999 })
    expect((await getSettings())['study.dailyGoal']).toBe(9999)
    await updateSettings({ 'study.dailyGoal': 30 })

    // task-51：dailyReviewCap 与 dailyGoal 同规则（0–9999 整数，越界/小数/字符串/NaN 拒绝）
    for (const bad of [-1, 10000, 1.5, '50', Number.NaN]) {
      await expect(updateSettings({ 'study.dailyReviewCap': bad as never }), `cap=${String(bad)}`).rejects.toThrow()
    }
    await updateSettings({ 'study.dailyReviewCap': 0 })
    expect((await getSettings())['study.dailyReviewCap']).toBe(0)
    await updateSettings({ 'study.dailyReviewCap': 9999 })
    expect((await getSettings())['study.dailyReviewCap']).toBe(9999)
    await updateSettings({ 'study.dailyReviewCap': 50 })
    expect((await getSettings())['study.dailyReviewCap']).toBe(50)

    // 其余数字型 key 仍是「clamp 后写回」（SPEC §5）
    await updateSettings({
      'board.exampleCount': 9,
      'memory.totalRepeats': 99,
      'memory.fontScale': 0.1,
      'memory.cardSize': 9,
      'app.fontScale': 0.1,
    })
    let s = await getSettings()
    expect(s['board.exampleCount']).toBe(3)
    expect(s['memory.totalRepeats']).toBe(10)
    expect(s['memory.fontScale']).toBe(0.8)
    expect(s['memory.cardSize']).toBe(1.4)
    expect(s['app.fontScale']).toBe(0.9)

    await updateSettings({
      'memory.totalRepeats': 0,
      'memory.fontScale': 9,
      'app.fontScale': 9,
    })
    s = await getSettings()
    expect(s['memory.totalRepeats']).toBe(1)
    expect(s['memory.fontScale']).toBe(1.6)
    expect(s['app.fontScale']).toBe(1.2)
  })

  it('非法枚举 / 未知 key / 不存在的 selectedDeckId → throw（不写脏数据）', async () => {
    await expect(updateSettings({ 'app.theme': 'purple' as never })).rejects.toThrow()
    await expect(updateSettings({ 'memory.mode': 'shuffle' as never })).rejects.toThrow()
    await expect(updateSettings({ 'no.such.key': 1 } as never)).rejects.toThrow()
    await expect(updateSettings({ 'data.selectedDeckId': 'not-exist-deck' })).rejects.toThrow()
    const s = await getSettings()
    expect(s['app.theme']).toBe('system')
    expect(s['memory.mode']).toBe('sequential')
  })
})
