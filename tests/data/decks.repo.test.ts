import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  addWord,
  addWords,
  createDeck,
  deleteDeck,
  deleteWord,
  ensureBuiltinDecks,
  getDb,
  getDeck,
  getDeckProgress,
  getSettings,
  getWord,
  getWords,
  getWordsPage,
  listDecks,
  renameDeck,
  resetDatabase,
  searchWords,
  setDefaultDeck,
  submitRating,
  updateDeck,
  updateWord,
  upsertWord,
} from '../../src/data'
import type { RawWordInput } from '../../src/data'

import manifest from '../../src/data/builtin/manifest.json'

import { BRAND } from '../../src/app/brand'
import { DECK_SOURCES } from '../../src/data'

const PRIMARY = BRAND.defaultDeckId
const SECONDARY = DECK_SOURCES.find((source) => source.deckId !== PRIMARY)?.deckId ?? null
const PRIMARY_COUNT = manifest.decks.find((deck) => deck.deckId === PRIMARY)!.wordCount

beforeEach(async () => {
  await resetDatabase()
})

const sampleWords: RawWordInput[] = [
  { headword: 'alpha', meanings: [{ pos: 'n.', cn: '阿尔法' }], tags: ['测试'] },
  { headword: 'beta', meanings: [{ pos: 'n.', cn: '贝塔' }] },
]

describe('词库 CRUD（AC6）', () => {
  it('新建 / 列表 / 重命名 / 更新 / 删除', async () => {
    const deck = await createDeck({ name: '我的词库', description: '自建', words: sampleWords })
    expect(deck.id).toMatch(/^deck-/)
    expect(deck.wordCount).toBe(2)
    expect(deck.source).toBe('custom')
    // 第一个词库自动成为默认 + 在学
    expect(deck.isDefault).toBe(true)
    expect((await getSettings())['data.selectedDeckId']).toBe(deck.id)

    expect((await listDecks()).map((item) => item.id)).toEqual([deck.id])
    expect((await getDeck(deck.id))?.name).toBe('我的词库')

    // 重名提示
    await expect(createDeck('我的词库')).rejects.toThrow(/同名词库/)

    const renamed = await renameDeck(deck.id, '改名后')
    expect(renamed.name).toBe('改名后')

    const updated = await updateDeck(deck.id, { description: '新描述', license: 'MIT' })
    expect(updated.description).toBe('新描述')
    expect(updated.license).toBe('MIT')

    await deleteDeck(deck.id)
    expect(await getDeck(deck.id)).toBeNull()
    expect(await getDb().words.count()).toBe(0)
  }, 30_000)

  it('内置词库列表默认库第一；删除内置库后可从种子恢复', async () => {
    await ensureBuiltinDecks()
    const decks = await listDecks()
    expect(decks[0]!.id).toBe(PRIMARY)
    expect(decks[0]!.isDefault).toBe(true)

    await deleteDeck(PRIMARY)
    expect(await getDb().decks.get(PRIMARY)).toBeUndefined()
    expect(await getDb().words.where('deckId').equals(PRIMARY).count()).toBe(0)
    // 当前在学词库切到另一个（若只有单内置词库则可能是空/回退）
    if (SECONDARY) expect((await getSettings())['data.selectedDeckId']).toBe(SECONDARY)

    const reseed = await ensureBuiltinDecks()
    expect(reseed.seeded).toContain(PRIMARY)
    expect(await getDb().words.where('deckId').equals(PRIMARY).count()).toBe(PRIMARY_COUNT)
  }, 180_000)

  it.skipIf(!SECONDARY)('setDefaultDeck 全局唯一（多内置词库）', async () => {
    await ensureBuiltinDecks()
    await setDefaultDeck(SECONDARY!)
    const decks = await listDecks()
    expect(decks[0]!.id).toBe(SECONDARY!)
    expect(decks[0]!.isDefault).toBe(true)
    expect(decks.find((deck) => deck.id === PRIMARY)?.isDefault).toBe(false)
  }, 120_000)
})

describe('词条增删改查', () => {
  it('addWord / upsertWord / updateWord / deleteWord', async () => {
    const deck = await createDeck('词条测试')
    const word = await addWord(deck.id, { headword: 'Zebra', meanings: [{ pos: 'n.', cn: '斑马' }] })
    expect(word.id).toBe(`${deck.id}:zebra`)
    expect(word.headword).toBe('Zebra')
    expect(word.headwordLower).toBe('zebra')
    expect(word.meanings[0]!.id).toBe(`${deck.id}:zebra#M1`)
    expect((await getDeck(deck.id))!.wordCount).toBe(1)

    // 同 headword 再加 → 报错
    await expect(addWord(deck.id, { headword: 'zebra' })).rejects.toThrow(/已存在/)

    // upsert 合并
    const upserted = await upsertWord(deck.id, {
      headword: 'zebra',
      meanings: [{ pos: 'n.', cn: '斑马' }, { pos: 'adj.', cn: '有条纹的' }],
      tags: ['我的'],
    })
    expect(upserted.meanings).toHaveLength(2)
    expect(upserted.order).toBe(word.order)
    expect((await getDeck(deck.id))!.wordCount).toBe(1)

    // updateWord：改释义
    const changed = await updateWord(upserted.id, { meanings: [{ cn: '斑马（动物）' }] })
    expect(changed.meanings[0]!.cn).toBe('斑马（动物）')
    // 不允许改拼写
    await expect(updateWord(upserted.id, { headword: 'other' })).rejects.toThrow(/拼写/)

    await deleteWord(upserted.id)
    expect(await getWord(upserted.id)).toBeNull()
    expect((await getDeck(deck.id))!.wordCount).toBe(0)
  }, 30_000)

  it('addWords 批量加词（同批去重）', async () => {
    const deck = await createDeck('批量')
    const added = await addWords(deck.id, [
      { headword: 'one', meaning: '一' },
      { headword: 'two', meaning: '二' },
      { headword: 'ONE', meaning: '一（重复）' },
    ])
    expect(added).toHaveLength(2)
    expect((await getDeck(deck.id))!.wordCount).toBe(2)
    expect(added.map((word) => word.order)).toEqual([1, 2])
  }, 30_000)
})

describe('分页 / 搜索 / 进度（AC6）', () => {
  it('getWordsPage 按 order 分页；getWords 批量取词', async () => {
    const deck = await createDeck({ name: '分页', words: sampleWords })
    const page1 = await getWordsPage(deck.id, { offset: 0, limit: 1 })
    expect(page1.total).toBe(2)
    expect(page1.words).toHaveLength(1)
    expect(page1.words[0]!.headword).toBe('alpha')
    const page2 = await getWordsPage(deck.id, { offset: 1, limit: 1 })
    expect(page2.words[0]!.headword).toBe('beta')
    const batch = await getWords([page1.words[0]!.id, page2.words[0]!.id, 'missing'])
    expect(batch.map((word) => word.headword)).toEqual(['alpha', 'beta'])
  }, 30_000)

  it('中文/英文/前缀搜索', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const first = (await db.words
      .where('[deckId+order]')
      .between([PRIMARY, -Infinity], [PRIMARY, Infinity])
      .first())!
    const prefix = first.headwordLower.slice(0, Math.min(4, first.headwordLower.length))
    const prefixResults = await searchWords(PRIMARY, prefix, 5)
    expect(prefixResults.length).toBeGreaterThan(0)
    expect(prefixResults.every((word) => word.headwordLower.startsWith(prefix))).toBe(true)

    const cnTerm = first.meanings[0]!.cn.replace(/^[a-z]+\.\s*/i, '').slice(0, 2)
    const chinese = await searchWords(PRIMARY, cnTerm, 5)
    expect(chinese.length).toBeGreaterThan(0)
    expect(chinese.every((word) => word.meanings.some((meaning) => meaning.cn.includes(cnTerm)))).toBe(true)

    expect(await searchWords(PRIMARY, '', 5)).toEqual([])
  }, 120_000)

  it('学习后 getDeckProgress / 过滤筛选正确', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const first = (await db.words
      .where('[deckId+order]')
      .between([PRIMARY, -Infinity], [PRIMARY, Infinity])
      .first())!
    await submitRating(first.id, 'familiar', Date.now())

    const progress = await getDeckProgress(PRIMARY)
    expect(progress.studiedCount).toBe(1)
    expect(progress.newCount).toBe(PRIMARY_COUNT - 1)
    expect(progress.reviewCount).toBe(1)
    expect(progress.progress).toBeCloseTo(1 / PRIMARY_COUNT, 6)

    const studiedPage = await getWordsPage(PRIMARY, { filter: 'studied', limit: 10 })
    expect(studiedPage.total).toBe(1)
    expect(studiedPage.words[0]!.id).toBe(first.id)

    const newPage = await getWordsPage(PRIMARY, { filter: 'new', limit: 5 })
    expect(newPage.total).toBe(PRIMARY_COUNT - 1)
    expect(newPage.words.some((word) => word.id === first.id)).toBe(false)

    const searchPage = await getWordsPage(PRIMARY, { search: first.headwordLower.slice(0, 3), limit: 10 })
    expect(searchPage.total).toBeGreaterThan(0)
  }, 180_000)
})
