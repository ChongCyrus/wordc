import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { BRAND } from '../../src/app/brand'

import {
  buildDeckFile,
  clearAllData,
  computeChecksum,
  deckFileName,
  exportDeck,
  exportMigration,
  getDb,
  getSettings,
  importCsv,
  importDeckFile,
  importMigration,
  migrationChecksumPayload,
  migrationFileName,
  recordMeaningClick,
  recordMeaningEncounters,
  resetDatabase,
  stableStringify,
  submitRating,
  updateSettings,
} from '../../src/data'
import type { MigrationFileWithMeta } from '../../src/data'
import { ensureBuiltinDecks } from '../../src/data'

const PRIMARY = BRAND.defaultDeckId
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime()

beforeEach(async () => {
  await resetDatabase()
})

/** 学几个词 + 改设置，制造非空 states/settings */
async function prepareData(): Promise<void> {
  await ensureBuiltinDecks()
  const db = getDb()
  const words = await db.words
    .where('[deckId+order]')
    .between([PRIMARY, -Infinity], [PRIMARY, Infinity])
    .limit(6)
    .toArray()
  const ratings = ['familiar', 'vague', 'forgot', 'familiar', 'familiar', 'vague'] as const
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    await recordMeaningEncounters(word.id, word.meanings.map((meaning) => meaning.id))
    await recordMeaningClick(word.id, word.meanings[0]!.id)
    await recordMeaningClick(word.id, word.meanings[0]!.id)
    await submitRating(word.id, ratings[i]!, NOW + i * 60_000)
  }
  // 同一天再评一次（longTermUpdate=false 的日志也要能往返）
  await submitRating(words[0]!.id, 'vague', NOW + 10 * 60_000)
  await updateSettings({ 'study.dailyGoal': 42, 'memory.totalRepeats': 5, 'memory.mode': 'random' })
}

function withoutUpdatedAt<T extends { updatedAt?: number }>(rows: T[]): T[] {
  return rows.map((row) => {
    const copy = { ...row }
    delete copy.updatedAt
    return copy
  })
}

describe('AC5：可迁移包往返一致', () => {
  it('exportMigration → clearAllData → importMigration(replace) 后 states/decks/words/settings 一致', async () => {
    await prepareData()
    const db = getDb()

    const deckBefore = await db.decks.toArray()
    const wordsBefore = await db.words.toArray()
    const statesBefore = await db.states.toArray()
    const logsBefore = await db.reviewLogs.toArray()
    const settingsBefore = await getSettings()

    const blob = await exportMigration()
    const text = await blob.text()
    expect(text.length).toBeGreaterThan(1000)
    const exported = JSON.parse(text) as MigrationFileWithMeta
    expect(exported.format).toBe('momo-migration')
    expect(exported.checksum).toHaveLength(64) // sha256（Node 有 WebCrypto）
    expect(exported.meta?.checksumAlgo).toBe('sha256')
    expect(exported.counts.states).toBe(statesBefore.length)
    // 隐私：token 不进迁移包（D23）
    expect(exported.data.settings.some((row) => row.key === 'data.maimemoToken')).toBe(false)

    await clearAllData()
    expect(await db.decks.count()).toBe(0)
    expect(await db.words.count()).toBe(0)
    expect(await db.states.count()).toBe(0)

    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok).toBe(true)
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])

    // states 逐字段相等（updatedAt 例外允许，AC5）
    const statesAfter = await db.states.toArray()
    expect(withoutUpdatedAt(statesAfter).sort((a, b) => (a.wordId < b.wordId ? -1 : 1))).toEqual(
      withoutUpdatedAt(statesBefore).sort((a, b) => (a.wordId < b.wordId ? -1 : 1)),
    )
    // decks / words / settings 一致
    expect(stableStringify(deckSort(await db.decks.toArray()))).toBe(stableStringify(deckSort(deckBefore)))
    expect(stableStringify(wordSort(await db.words.toArray()))).toBe(stableStringify(wordSort(wordsBefore)))
    expect(await getSettings()).toEqual(settingsBefore)
    // 日志也按 replace 恢复（条数一致）
    expect(await db.reviewLogs.count()).toBe(logsBefore.length)
  }, 180_000)

  it('checksum 被篡改 → 拒绝导入且不写库；force:true 可强制导入', async () => {
    await prepareData()
    const text = await (await exportMigration()).text()
    const file = JSON.parse(text) as MigrationFileWithMeta
    const targetDeck = file.data.decks.find((deck) => deck.id === PRIMARY)!
    targetDeck.name = `${targetDeck.name}（被改）`
    const tampered = stableStringify(file)

    await clearAllData()
    const rejected = await importMigration(tampered)
    expect(rejected.ok).toBe(false)
    expect(rejected.issues.some((issue) => issue.code === 'E_CHECKSUM')).toBe(true)
    expect(await getDb().decks.count()).toBe(0) // 拒绝时不写库

    const forced = await importMigration(tampered, { force: true })
    expect(forced.ok).toBe(true)
    expect(forced.issues.some((issue) => issue.code === 'E_CHECKSUM' && issue.level === 'warning')).toBe(true)
    expect((await getDb().decks.get(PRIMARY))!.name).toContain('（被改）')
  }, 180_000)

  it('坏格式 / 版本不兼容 / 坏字段 → 结构化错误且不写库', async () => {
    await prepareData()
    const db = getDb()
    const deckCount = await db.decks.count()

    const notJson = await importMigration('{ this is not json')
    expect(notJson.ok).toBe(false)
    expect(notJson.issues[0]!.code).toBe('E_FORMAT')

    const wrongFormat = await importMigration('{"format":"other","formatVersion":1}')
    expect(wrongFormat.issues[0]!.code).toBe('E_FORMAT')

    const wrongVersion = await importMigration('{"format":"momo-migration","formatVersion":2,"dataVersion":2}')
    expect(wrongVersion.issues[0]!.code).toBe('E_VERSION')

    // 合法 checksum + 坏字段（headword 为空）→ E_FIELD（带 path）
    const source = JSON.parse(await (await exportMigration()).text()) as MigrationFileWithMeta
    const brokenWord = source.data.words[0] as unknown as Record<string, unknown>
    brokenWord.headword = ''
    brokenWord.term = ''
    source.checksum = (await computeChecksum(migrationChecksumPayload(source))).hex
    const badField = await importMigration(stableStringify(source))
    expect(badField.ok).toBe(false)
    const fieldIssue = badField.issues.find((issue) => issue.code === 'E_FIELD' && issue.level === 'error')
    expect(fieldIssue).toBeTruthy()
    expect(fieldIssue!.path).toContain('words[0]')
    expect(await db.decks.count()).toBe(deckCount) // 未写库
  }, 180_000)

  it('merge 策略：取较新 state，clicks/encounters 取 max；不重复导入日志', async () => {
    await prepareData()
    const db = getDb()
    const text = await (await exportMigration()).text()
    const before = await db.states.toArray()
    const target = before[0]!
    // 本机改旧：模拟「另一台设备学习更多」
    await db.states.put({
      ...target,
      lastReviewedAt: target.lastReviewedAt! - 10 * 86_400_000,
      meaningStats: Object.fromEntries(
        Object.keys(target.meaningStats).map((id) => [id, { clicks: 9, encounters: 9 }]),
      ),
      updatedAt: Date.now(),
    })
    const logsBefore = await db.reviewLogs.count()

    const report = await importMigration(text, { strategy: 'merge' })
    expect(report.ok).toBe(true)
    expect(await db.reviewLogs.count()).toBe(logsBefore) // 合并模式不追加日志
    const merged = await db.states.get(target.wordId)
    expect(merged!.lastReviewedAt).toBe(target.lastReviewedAt) // 包里更新 → 用包里的
    const stats = Object.values(merged!.meaningStats)
    expect(stats[0]!.clicks).toBe(Math.max(9, target.meaningStats[Object.keys(target.meaningStats)[0]!]!.clicks))
    expect(stats[0]!.encounters).toBeGreaterThanOrEqual(9)
    expect(report.issues.some((issue) => issue.code === 'W_SKIPPED')).toBe(true)
  }, 180_000)

  it('keepNewer 策略：本机 state 更新时保留本机', async () => {
    await prepareData()
    const db = getDb()
    const text = await (await exportMigration()).text()
    const target = (await db.states.toArray())[0]!
    const laterReview = target.lastReviewedAt! + 5 * 86_400_000
    await db.states.put({ ...target, lastReviewedAt: laterReview, stability: 999, updatedAt: Date.now() })

    const report = await importMigration(text, { strategy: 'keepNewer' })
    expect(report.ok).toBe(true)
    const after = await db.states.get(target.wordId)
    expect(after!.lastReviewedAt).toBe(laterReview)
    expect(after!.stability).toBe(999)
  }, 180_000)
})

describe('纯词库导出 / 导入', () => {
  it('exportDeck → importDeckFile(replace) 词条数/id 规则一致，且清除该库 states', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const wordsBefore = await db.words.where('deckId').equals(PRIMARY).count()
    const file = await buildDeckFile(PRIMARY)
    expect(file.format).toBe('momo-deck')
    expect(file.words).toHaveLength(wordsBefore)
    expect(file.meta.wordCount).toBe(wordsBefore)
    expect(file.meta.license?.trim().length).toBeGreaterThan(0)
    expect(file.meta.license).toMatch(/CC|版权|许可|license/i)

    const text = await (await exportDeck(PRIMARY)).text()
    const first = (await db.words.where('[deckId+order]').between([PRIMARY, -Infinity], [PRIMARY, Infinity]).first())!
    await submitRating(first.id, 'familiar', NOW)
    expect(await db.states.where('deckId').equals(PRIMARY).count()).toBe(1)

    const report = await importDeckFile(text, { strategy: 'replace' })
    expect(report.ok).toBe(true)
    expect(report.counts.words).toBe(wordsBefore)
    expect(await db.words.where('deckId').equals(PRIMARY).count()).toBe(wordsBefore)
    // replace：该库 states 被清空
    expect(await db.states.where('deckId').equals(PRIMARY).count()).toBe(0)
  }, 180_000)

  it('非 JSON / 非词库文件 → E_FORMAT；版本 2 → E_VERSION', async () => {
    const badJson = await importDeckFile('not-json')
    expect(badJson.ok).toBe(false)
    expect(badJson.issues[0]!.code).toBe('E_FORMAT')
    const notDeck = await importDeckFile('{"format":"momo-migration"}')
    expect(notDeck.issues[0]!.code).toBe('E_FORMAT')
    const badVersion = await importDeckFile('{"format":"momo-deck","formatVersion":2}')
    expect(badVersion.issues[0]!.code).toBe('E_VERSION')
  })

  it('文件名辅助函数', async () => {
    await ensureBuiltinDecks()
    const deck = (await getDb().decks.get(PRIMARY))!
    expect(deckFileName(deck)).toMatch(/\.deck\.json$/)
    expect(deckFileName(deck)).not.toContain(' ')
    expect(migrationFileName(NOW)).toBe('momo-backup-2026-11-10.migration.json')
  }, 120_000)
})

describe('QA-01：导入不能造出第二个默认词库', () => {
  const deckFile = (id: string, isDefault: boolean) => ({
    format: 'momo-deck',
    formatVersion: 1,
    exportedAt: 1,
    generator: 'test',
    deck: {
      id,
      name: `QA ${id}`,
      source: 'imported',
      wordCount: 1,
      version: 1,
      isDefault,
      createdAt: 1,
      updatedAt: 1,
    },
    words: [{ headword: 'alpha', meanings: [{ cn: '阿尔法' }] }],
    meta: { wordCount: 1 },
  })

  it('导入带 isDefault=true 的 DeckFile 时保留本机已有默认词库', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const report = await importDeckFile(stableStringify(deckFile('qa-default-deck', true)))
    expect(report.ok).toBe(true)
    const defaults = (await db.decks.toArray()).filter((deck) => deck.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]!.id).toBe(PRIMARY)
  }, 120_000)

  it('空数据库导入 isDefault=false 的 DeckFile → 自动成为默认（保持恰好一个）', async () => {
    const db = getDb()
    await importDeckFile(stableStringify(deckFile('only-deck', false)))
    const defaults = (await db.decks.toArray()).filter((deck) => deck.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]!.id).toBe('only-deck')
  })

  it('导入可迁移包后默认词库仍唯一（本机默认优先）', async () => {
    await prepareData()
    const db = getDb()
    const text = await (await exportMigration()).text()
    const file = JSON.parse(text) as MigrationFileWithMeta
    // 注入一个额外的默认词库
    file.data.decks.push({
      id: 'qa-extra-default',
      name: 'QA extra',
      source: 'imported',
      wordCount: 0,
      version: 1,
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    })
    file.checksum = (await computeChecksum(migrationChecksumPayload(file))).hex
    const report = await importMigration(stableStringify(file), { strategy: 'merge' })
    expect(report.ok).toBe(true)
    const defaults = (await db.decks.toArray()).filter((deck) => deck.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]!.id).toBe(PRIMARY)
  }, 120_000)
})

describe('CSV 导入（§6.3 / AC5）', () => {
  it('引号逗号、多义分号、重复行合并、BOM 都能正确处理', async () => {
    const csv = [
      'headword,pos,meaning,example,exampleTranslation,phoneticUK,phoneticUS,tags',
      'abandon,vt.,"放弃；抛弃","He abandoned the plan.","他放弃了计划",,[əˈbændən],我的词',
      'abandon,vt.,放弃,,,,"",我的词',
      'apple,n.,"苹果, 苹果树",,,,,[əˈpl]',
      '"ice cream",n.,冰淇淋,,,,,',
    ].join('\r\n')
    const report = await importCsv(`\uFEFF${csv}`, '我的词单')
    expect(report.ok).toBe(true)
    expect(report.kind).toBe('csv')
    expect(report.counts.words).toBe(3)

    const db = getDb()
    const deck = (await db.decks.toArray()).find((item) => item.name === '我的词单')!
    expect(deck.source).toBe('imported')
    const words = await db.words.where('deckId').equals(deck.id).toArray()
    const abandon = words.find((word) => word.headwordLower === 'abandon')!
    expect(abandon.meanings.map((meaning) => meaning.cn)).toEqual(['放弃', '抛弃'])
    expect(abandon.meanings[0]!.pos).toBe('vt.')
    expect(abandon.examples[0]!.cn).toBe('他放弃了计划')
    expect(abandon.phonetic?.us).toBe('[əˈbændən]')
    expect(abandon.tags).toContain('我的词')
    const apple = words.find((word) => word.headwordLower === 'apple')!
    expect(apple.meanings[0]!.cn).toBe('苹果, 苹果树')
    const iceCream = words.find((word) => word.headwordLower === 'ice cream')!
    expect(iceCream.headword).toBe('ice cream')
    // id 规则：空格规范化
    expect(iceCream.id).toBe(`${deck.id}:ice cream`)
  }, 60_000)

  it('缺 headword 行 → E_FIELD 带行号且不写库', async () => {
    const csv = ['headword,meaning', ',坏行', 'apple,苹果'].join('\n')
    const report = await importCsv(csv)
    expect(report.ok).toBe(false)
    const issue = report.issues.find((item) => item.code === 'E_FIELD')
    expect(issue?.row).toBe(2)
    expect(await getDb().decks.count()).toBe(0)
  })

  it('只有表头（没有词条）→ E_FIELD，不写库', async () => {
    const report = await importCsv('headword,meaning\n')
    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'E_FIELD')).toBe(true)
    expect(await getDb().decks.count()).toBe(0)
  })

  it('无释义行给出 W_NO_MEANING 警告但导入成功', async () => {
    const report = await importCsv('headword,meaning\nzzzz,', '无释义测试')
    expect(report.ok).toBe(true)
    expect(report.issues.some((issue) => issue.code === 'W_NO_MEANING')).toBe(true)
  })
})

function deckSort<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function wordSort<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
