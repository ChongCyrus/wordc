/**
 * task-138 · B3 apply 完整/中断恢复 + B2 AI 包合并
 */
import './test-utils'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
import {
  appendAiPack,
  applyApproved,
  approveItems,
  getPackApplyBreakdown,
  importPack,
  listPackItems,
  listPacks,
  mergeDuplicateAiPacks,
  reapplyPack,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function makePack(items: PackItemV1[], meta: Record<string, unknown> = {}): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'mixed' as const,
    createdAt: Date.UTC(2026, 11, 14),
    generator: 'test@task-138',
    items,
    meta: { source: 'ai' as const, ...meta },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

async function makeDeck(wordCount: number, meaningCount = 4) {
  const deck = await createDeck({
    name: `task138-${wordCount}`,
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `w${index}`,
      meanings: Array.from({ length: meaningCount }, (_, meaning) => ({ pos: 'n.', cn: `w${index}-义${meaning + 1}` })),
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

function phraseItems(wordCount: number, meaningCount: number): PackItemV1[] {
  const items: PackItemV1[] = []
  for (let index = 0; index < wordCount; index += 1) {
    for (let meaning = 1; meaning <= meaningCount; meaning += 1) {
      items.push({
        headword: `w${index}`,
        headwordLower: `w${index}`,
        meaningIndex: meaning,
        phrases: [1, 2, 3, 4, 5].map((n) => ({ en: `w${index} m${meaning} phrase ${n}`, cn: `短语${n}` })),
      })
    }
  }
  return items
}

function contentItems(_deckId: string, wordCount: number, meaningCount: number): PackItemV1[] {
  const items: PackItemV1[] = []
  for (let index = 0; index < wordCount; index += 1) {
    for (let meaning = 1; meaning <= meaningCount; meaning += 1) {
      items.push({
        headword: `w${index}`,
        headwordLower: `w${index}`,
        meaningIndex: meaning,
        examples: [1, 2, 3].map((n) => ({ en: `w${index} meaning${meaning} example ${n}`, cn: `例句${n}` })),
        phrases: [1, 2, 3].map((n) => ({ en: `w${index} m${meaning} phrase ${n}`, cn: `短语${n}` })),
        mnemonics: [{ type: '联想', text: `w${index} 助记${meaning}` }],
      })
    }
  }
  return items
}

describe('task-138 B3 · apply 全量/中断恢复/重应用补齐', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('大批量 apply 分 500/批；因 limit 跳过 → reapply 补齐后 applied==items', async () => {
    const deck = await makeDeck(200, 4) // 800 items，每词 12 phrases > 8 limit
    const file = await makePack(phraseItems(200, 4), { deckId: deck.id })
    const imported = await importPack(JSON.stringify(file))
    expect(imported.packId).toBeDefined()
    const packId = imported.packId!
    const items = await listPackItems(packId)
    expect(items.length).toBe(800)
    await approveItems(packId, items.map((item) => item.id))

    const progress: number[] = []
    const first = await applyApproved(packId, {
      batchSize: 500,
      onProgress: (entry) => progress.push(entry.done),
    })
    expect(progress).toContain(500)
    expect(progress.at(-1)).toBe(800)
    expect(first.applied + first.skipped).toBe(800)
    expect(first.skipped).toBeGreaterThan(0) // phrases 每词上限 8
    expect((first.skippedByReason?.limit ?? 0)).toBeGreaterThan(0)
    const beforeRepair = await getPackApplyBreakdown(packId)
    expect(beforeRepair?.skippedByReason.limit).toBeGreaterThan(0)
    expect(beforeRepair?.retryableSkipped).toBeGreaterThan(0)

    const reapplyProgress: string[] = []
    const repaired = await reapplyPack(packId, {
      batchSize: 300,
      onProgress: (entry) => {
        reapplyProgress.push(entry.phase)
      },
    })
    expect(repaired.applied).toBeGreaterThan(0)
    expect(reapplyProgress).toContain('apply')
    const afterItems = await listPackItems(packId)
    expect(afterItems.filter((item) => item.status === 'applied').length).toBe(800)
    const pack = await getDb().packs.get(packId)
    expect(pack!.counts.applied).toBe(800)
    expect(pack!.counts.items).toBe(800)
    const afterRepair = await getPackApplyBreakdown(packId)
    expect(afterRepair?.skipped).toBe(0)
    expect(afterRepair?.applied).toBe(800)
  }, 120_000)

  it('旧 pack 的 unknown-meaning（义项序号超范围）：reapply 降级词级补齐', async () => {
    const deck = await makeDeck(1, 2)
    const db = getDb()
    const word = (await db.words.get(`${deck.id}:w0`))!
    const packId = 'pk_legacy_unknown_meaning'
    const now = Date.now()
    await db.packs.put({
      id: packId,
      name: '旧 WordC 包（义项超范围）',
      kind: 'mixed',
      formatVersion: 1,
      checksum: 'legacy-checksum',
      source: 'ai',
      deckId: deck.id,
      status: 'partial',
      counts: { items: 1, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 1 },
      createdAt: now,
      updatedAt: now,
    })
    await db.packItems.put({
      id: `${packId}:1`,
      packId,
      seq: 1,
      headword: 'w0',
      headwordLower: 'w0',
      meaningIndex: 3, // 当前词库只有 2 个义项 → 旧版 apply skipped:unknown-meaning
      payload: {
        headword: 'w0',
        headwordLower: 'w0',
        meaningIndex: 3,
        examples: [{ en: 'legacy fallback example', cn: '旧包例句' }],
        phrases: [{ en: 'legacy fallback phrase', cn: '旧包短语', meaningIndex: 3 }],
      },
      status: 'skipped',
      skipReason: 'unknown-meaning',
      contentHashes: [],
      createdAt: now,
    })

    const result = await reapplyPack(packId)
    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(0)
    const afterWord = (await db.words.get(word.id))!
    expect(afterWord.examples.some((example) => example.en === 'legacy fallback example')).toBe(true)
    expect(afterWord.phrases.some((phrase) => phrase.en === 'legacy fallback phrase')).toBe(true)
    const breakdown = await getPackApplyBreakdown(packId)
    expect(breakdown?.skipped).toBe(0)
    expect(breakdown?.applied).toBe(1)
  })

  it('unknown-word（包内词不在当前词库）：breakdown 明确分类，重应用无法补齐', async () => {
    const deck = await makeDeck(3, 2)
    const file = await makePack(
      [
        { headword: 'w0', headwordLower: 'w0', meaningIndex: 1, examples: [{ en: 'known item', cn: '已知' }] },
        { headword: 'not-in-deck', headwordLower: 'not-in-deck', meaningIndex: 1, examples: [{ en: 'unknown item', cn: '未知' }] },
      ],
      { deckId: deck.id },
    )
    const imported = await importPack(JSON.stringify(file))
    const packId = imported.packId!
    expect(imported.preview.skipped.some((skip) => skip.reason === 'unknown-word')).toBe(true)
    const items = await listPackItems(packId)
    await approveItems(packId, items.filter((item) => item.status === 'pending').map((item) => item.id))
    const before = await getPackApplyBreakdown(packId)
    expect(before?.unknownWordItems).toBe(1)
    expect(before?.skippedByReason['unknown-word']).toBe(1)
    const reapply = await reapplyPack(packId)
    expect(reapply.applied).toBeGreaterThanOrEqual(0) // 不能补齐未知词
    const after = await getPackApplyBreakdown(packId)
    expect(after?.unknownWordItems).toBe(1) // 明确提示「不属于当前词库」，不误报为可补齐
    expect(after?.retryableSkipped).toBe(0)
  })

  it('模拟批次中途 DB 异常：返回 errors 且后续批次继续；再次 reapply 补齐全部', async () => {
    const deck = await makeDeck(100, 4)
    const file = await makePack(contentItems(deck.id, 100, 4), { deckId: deck.id })
    const imported = await importPack(JSON.stringify(file))
    const packId = imported.packId!
    const items = await listPackItems(packId)
    await approveItems(packId, items.map((item) => item.id))

    const db = getDb()
    const spy = vi.spyOn(db.words, 'bulkPut').mockRejectedValueOnce(new Error('simulated-idb-failure'))
    const first = await applyApproved(packId, { batchSize: 100 })
    spy.mockRestore()
    expect((first.errors ?? []).length).toBeGreaterThan(0) // 失败批次已记录
    expect(first.applied).toBeGreaterThan(0) // 后续批次继续，未整体中断

    const repaired = await reapplyPack(packId, { batchSize: 100 })
    expect(repaired.applied).toBeGreaterThan(0)
    const afterItems = await listPackItems(packId)
    expect(afterItems.filter((item) => item.status === 'applied').length).toBe(400)
    const pack = await getDb().packs.get(packId)
    expect(pack!.counts.applied).toBe(400)
  }, 120_000)
})

describe('task-138 B2 · 同 deck AI 内容包合并复用', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('第二次 appendAiPack 复用同 deck 已有 AI 包（不新建），items 合并且可应用', async () => {
    const deck = await makeDeck(20, 2)
    const pack1 = await makePack(contentItems(deck.id, 10, 2), { deckId: deck.id })
    const first = await appendAiPack(JSON.stringify(pack1))
    expect(first.merged).toBe(false)
    expect(await listPacks()).toHaveLength(1)

    const pack2 = await makePack(
      contentItems(deck.id, 20, 2).filter((item) => Number(item.headword!.slice(1)) >= 10),
      { deckId: deck.id },
    )
    const second = await appendAiPack(JSON.stringify(pack2))
    expect(second.merged).toBe(true)
    expect(second.packId).toBe(first.packId)
    const packs = await listPacks()
    expect(packs).toHaveLength(1) // 不再出现 1/1 新包
    const items = await listPackItems(first.packId)
    expect(items.length).toBe(40) // 20 词 × 2 义
    expect(packs[0]!.source).toBe('ai')
  }, 60_000)

  it('已有重复 AI 包：mergeDuplicateAiPacks 合并为 1 个并删除多余记录', async () => {
    const deck = await makeDeck(10, 2)
    const base = await makePack(contentItems(deck.id, 5, 2), { deckId: deck.id })
    const imported = await importPack(JSON.stringify(base))
    const keeper = (await getDb().packs.get(imported.packId!))!
    const sourceItems = await listPackItems(keeper.id)

    // 模拟旧版每次生成产生的重复 AI 包
    const dupId = `${keeper.id}_dup`
    await getDb().packs.put({ ...keeper, id: dupId, checksum: 'dup-checksum', createdAt: keeper.createdAt + 1000 })
    await getDb().packItems.bulkPut(
      sourceItems.map((item, index) => ({ ...item, id: `${dupId}:${index + 1}`, packId: dupId })),
    )
    expect(await listPacks()).toHaveLength(2)

    const result = await mergeDuplicateAiPacks()
    expect(result.removed).toBe(1)
    const remaining = await listPacks()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.source).toBe('ai')
    expect(await listPackItems(remaining[0]!.id)).toHaveLength(10)
  }, 60_000)
})
