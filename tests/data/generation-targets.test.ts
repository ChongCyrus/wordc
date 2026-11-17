import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  TARGET_PAGE_MAX,
  applyReplacementPack,
  clearContentForReplace,
  createDeck,
  getEffectiveContent,
  importPack,
  getDb,
  pendingGenerationTargetsPage,
  rejectGeneratedItem,
  resetDatabase,
  selectTargetPage,
  selectTargets,
  updateSettings,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function makePack(items: PackItemV1[], kind: PackFileV1['kind'] = 'semantics'): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind,
    createdAt: Date.now(),
    generator: 'test@targets',
    items,
    meta: { source: 'ai' as const },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

async function setupDeck() {
  const deck = await createDeck({
    name: '目标范围词库',
    words: [
      { headword: 'apple', meanings: [{ pos: 'n.', cn: '苹果' }, { pos: 'n.', cn: '苹果树' }] },
      { headword: 'application', meanings: [{ pos: 'n.', cn: '应用' }, { pos: 'n.', cn: '申请' }] },
      { headword: 'apricot', meanings: [{ pos: 'n.', cn: '杏' }] }, // 单含义
      { headword: 'banana', meanings: [{ pos: 'n.', cn: '香蕉' }, { pos: 'n.', cn: '芭蕉' }] },
      { headword: 'cat', meanings: [{ pos: 'n.', cn: '猫' }] }, // 单含义
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

beforeEach(async () => {
  await resetDatabase()
})

describe('task-84：生成目标范围扩展 / 分页 / 语义多含义过滤', () => {
  it('deck scope：任意 deckId（不必是当前在学）+ total/truncated', async () => {
    const deck = await setupDeck()
    const page = await selectTargetPage({ kind: 'deck', deckId: deck.id }, 'examples', {}, { limit: 3 })
    expect(page.targets).toHaveLength(3)
    expect(page.total).toBe(5)
    expect(page.truncated).toBe(true)
    const all = await selectTargetPage({ kind: 'deck', deckId: deck.id }, 'examples')
    expect(all.targets).toHaveLength(5)
    expect(all.truncated).toBe(false)
    expect(all.total).toBe(5)
  })

  it('words scope：自定义 id 列表（去重、未知 id 忽略）', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const words = await db.words.where('deckId').equals(deck.id).toArray()
    const apple = words.find((word) => word.headwordLower === 'apple')!
    const cat = words.find((word) => word.headwordLower === 'cat')!
    const page = await selectTargetPage(
      { kind: 'words', wordIds: [apple.id, cat.id, apple.id, 'missing:word'] },
      'examples',
    )
    expect(page.targets.map((target) => target.headword).sort()).toEqual(['apple', 'cat'])
    expect(page.total).toBe(2)
  })

  it('prefix/range scope：按 headwordLower 字母序过滤指定词库', async () => {
    const deck = await setupDeck()
    const page = await selectTargetPage({ kind: 'prefix', deckId: deck.id, prefix: 'ap' }, 'examples')
    expect(page.targets.map((target) => target.headwordLower)).toEqual(['apple', 'application', 'apricot'])
    expect(page.total).toBe(3)
    const range = await selectTargetPage({ kind: 'range', deckId: deck.id, prefix: 'ap' }, 'examples')
    expect(range.targets.map((target) => target.headwordLower)).toEqual(['apple', 'application', 'apricot'])
  })

  it('semantics scope：只返回 ≥2 含义词；目标带 meanings(cn/pos) 与 existing', async () => {
    const deck = await setupDeck()
    const page = await selectTargetPage({ kind: 'deck', deckId: deck.id }, 'semantics')
    const headwords = page.targets.map((target) => target.headword).sort()
    expect(headwords).toEqual(['apple', 'application', 'banana']) // apricot/cat 单含义被排除
    const apple = page.targets.find((target) => target.headword === 'apple')!
    expect(apple.meanings.map((meaning) => meaning.cn)).toEqual(['苹果', '苹果树'])
    expect(apple.meanings[0]!.pos).toBe('n.')
    expect(apple.existing).toEqual({ examples: 0, phrases: 0, mnemonics: 0 })
  })

  it('semantics onlyMissing：已有已应用 coreSenses/meaningMap 的词排除；已拒绝内容排除', async () => {
    const deck = await setupDeck()
    // 先应用一条语义 pack 到 apple（直接写 applied 记录，模拟已生成）
    const pack: PackFileV1 = await makePack(
      [
        {
          headword: 'apple',
          coreSenses: [{ index: 1, label: '果实', confidence: 'high' }],
          meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
        },
      ],
      'semantics',
    )
    const { importPack, approveItems, applyApproved, listPackItems } = await import('../../src/data')
    const imported = await importPack(JSON.stringify(pack))
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    await applyApproved(imported.packId!)
    await wait(2)

    const page = await pendingGenerationTargetsPage({ kind: 'deck', deckId: deck.id }, 'semantics')
    expect(page.targets.map((target) => target.headword).sort()).toEqual(['application', 'banana']) // apple 已有语义

    // 拒绝 banana 的语义内容 → 也被排除
    await rejectGeneratedItem({
      headword: 'banana',
      coreSenses: [{ index: 1, label: '香蕉' }],
      meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
    })
    const afterReject = await pendingGenerationTargetsPage({ kind: 'deck', deckId: deck.id }, 'semantics')
    expect(afterReject.targets.map((target) => target.headword)).toEqual(['application'])
    expect(deck.id).toBeTruthy()
  })

  it('分页上限：单次最多 500；offset 翻页 truncated 正确', async () => {
    const deck = await createDeck({
      name: '大词库',
      words: Array.from({ length: 600 }, (_, index) => ({
        headword: `w${String(index).padStart(4, '0')}`,
        meanings: [{ pos: 'n.', cn: `词${index}` }],
      })),
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const first = await selectTargetPage({ kind: 'deck', deckId: deck.id }, 'examples', {}, { limit: 9999 })
    expect(first.targets).toHaveLength(TARGET_PAGE_MAX) // 上限 500
    expect(first.total).toBe(600)
    expect(first.truncated).toBe(true)
    const second = await selectTargetPage({ kind: 'deck', deckId: deck.id }, 'examples', {}, { offset: 500, limit: 500 })
    expect(second.targets).toHaveLength(100)
    expect(second.truncated).toBe(false)
    // 旧数组 API 仍然可用（兼容）
    const legacy = await selectTargets({ kind: 'deck', deckId: deck.id, offset: 590, limit: 5 }, 'examples')
    expect(legacy).toHaveLength(5)
  })

  it('task-108：meanings scope 按指定 c 多选生成，目标带 meaningIndex', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const apple = (await db.words.where('deckId').equals(deck.id).toArray()).find((word) => word.headwordLower === 'apple')!
    const page = await selectTargetPage({ kind: 'meanings', wordId: apple.id, meaningIndexes: [1, 2] }, 'examples')
    expect(page.targets).toHaveLength(2)
    expect(page.targets.map((target) => target.meaningIndex).sort()).toEqual([1, 2])
    const onlyTwo = await selectTargetPage({ kind: 'meanings', wordId: apple.id, meaningIndexes: [2] }, 'examples')
    expect(onlyTwo.targets).toHaveLength(1)
    expect(onlyTwo.targets[0]!.meaningIndex).toBe(2)
  })

  it('task-107：append/replace 模式忽略已有内容，missing 仍排除', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const apple = (await db.words.where('deckId').equals(deck.id).toArray()).find((word) => word.headwordLower === 'apple')!
    await db.words.update(apple.id, { examples: [{ en: 'An apple.', cn: '一个苹果。' }] })
    const missing = await selectTargetPage({ kind: 'word', wordId: apple.id }, 'examples')
    expect(missing.targets).toHaveLength(0)
    const append = await selectTargetPage({ kind: 'word', wordId: apple.id }, 'examples', { mode: 'append' })
    expect(append.targets).toHaveLength(1)
    const replace = await selectTargetPage({ kind: 'word', wordId: apple.id }, 'examples', { mode: 'replace' })
    expect(replace.targets).toHaveLength(1)
  })

  it('task-107：clearContentForReplace 清空内容并删除旧 semantics packItems', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const apple = (await db.words.where('deckId').equals(deck.id).toArray()).find((word) => word.headwordLower === 'apple')!
    await db.words.update(apple.id, {
      examples: [{ en: 'Old.', cn: '旧。' }],
      phrases: [{ en: 'old phrase', cn: '旧词组' }],
      mnemonics: [{ type: '联想', text: '旧助记' }],
    })
    const pack = await makePack([
      { headword: 'apple', coreSenses: [{ index: 1, label: '苹果', confidence: 'high' }], meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }] },
    ])
    await db.packItems.put({
      id: 'p1:1', packId: 'p1', seq: 1, headword: 'apple', headwordLower: 'apple',
      wordId: apple.id, deckId: deck.id, payload: pack.items[0]!, status: 'applied',
      contentHashes: [], createdAt: Date.now(),
    })
    const result = await clearContentForReplace([apple.id], ['examples', 'phrases', 'mnemonics', 'semantics'])
    expect(result.words).toBe(1)
    expect(result.items).toBe(1)
    const updated = await db.words.get(apple.id)
    expect(updated?.examples).toEqual([])
    expect(updated?.phrases).toEqual([])
    expect(updated?.mnemonics).toEqual([])
    expect(await db.packItems.where('wordId').equals(apple.id).count()).toBe(0)
  })


  it('task-124：替换本义（applyReplacementPack）旧 semantics 清理、新 semantics applied 且 effective 非空', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const apple = (await db.words.where('deckId').equals(deck.id).toArray()).find((word) => word.headwordLower === 'apple')!
    const now = Date.now()
    await db.packs.put({
      id: 'old-sem', name: '旧语义', kind: 'semantics', formatVersion: 1, checksum: 'old-sem',
      source: 'ai', promptVersion: 'v4.0-semantics-grouped', deckId: deck.id, status: 'applied',
      counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 },
      createdAt: now, updatedAt: now,
    })
    await db.packItems.put({
      id: 'old-sem:1', packId: 'old-sem', seq: 1, headword: 'apple', headwordLower: 'apple',
      wordId: apple.id, deckId: deck.id, meaningIndex: 1, payload: {
        headword: 'apple', coreSenses: [{ index: 1, label: '旧本义', confidence: 'low' }],
        meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
      }, status: 'applied', contentHashes: [], createdAt: now,
    })
    const fresh = await makePack([
      {
        headword: 'apple',
        coreSenses: [{ index: 1, label: '苹果', note: '一种水果', confidence: 'high' }],
        meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1, steps: ['树上果实', '一种水果'] }],
      },
    ], 'semantics')
    const imported = await importPack(JSON.stringify(fresh), { resolveAllDecks: true })
    expect(imported.ok).toBe(true)
    const result = await applyReplacementPack(imported.packId!, [apple.id], ['semantics'])
    expect(result.applied).toBeGreaterThan(0)
    expect(await db.packItems.get('old-sem:1')).toBeUndefined()
    const newItems = await db.packItems.where('packId').equals(imported.packId!).toArray()
    expect(newItems.some((item) => item.status === 'applied')).toBe(true)
    const effective = await getEffectiveContent(apple.id, `${apple.id}#M1`)
    expect(effective?.meaning?.coreSense?.label).toBe('苹果')
    expect(JSON.stringify(effective)).not.toContain('旧本义')
    // 重复替换同一 pack：幂等，不清空已应用的新本义
    const again = await applyReplacementPack(imported.packId!, [apple.id], ['semantics'])
    expect(again.applied).toBeGreaterThan(0)
    const effectiveAgain = await getEffectiveContent(apple.id, `${apple.id}#M1`)
    expect(effectiveAgain?.meaning?.coreSense?.label).toBe('苹果')

    // 空替换：不应清旧数据；旧 items 保留、抛错
    const oldBefore = await db.packItems.get('old-sem:1')
    await expect(applyReplacementPack('missing-pack', [apple.id], ['semantics'])).rejects.toThrow(/替换内容为空/)
    expect(await db.packItems.get('old-sem:1')).toEqual(oldBefore)

  })


  it('task-128：mnemonics deck scope 按每个 c 生成目标（带 meaningIndex）', async () => {
    const deck = await setupDeck()
    const page = await selectTargetPage({ kind: 'deck', deckId: deck.id }, 'mnemonics')
    const apple = page.targets.filter((target) => target.headwordLower === 'apple')
    expect(apple.map((target) => target.meaningIndex)).toEqual([1, 2])
    expect(page.targets.filter((target) => target.headwordLower === 'apricot').map((target) => target.meaningIndex)).toEqual([1])
  })


  it('task-130：mnemonics missing 模式按 c 判断已有，旧词级助记不阻塞 per-c', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const apple = (await db.words.where('deckId').equals(deck.id).toArray()).find((word) => word.headwordLower === 'apple')!
    await db.words.update(apple.id, {
      mnemonics: [{ type: '联想', text: '旧词级助记', meaningId: `${apple.id}#M1` }],
    })
    const page = await selectTargetPage({ kind: 'word', wordId: apple.id }, 'mnemonics')
    expect(page.targets.map((target) => target.meaningIndex)).toEqual([2])
  })

})
