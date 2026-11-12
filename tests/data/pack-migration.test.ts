/**
 * task-99/0.3.15 · 旧 v3 semantics pack → v4 替换迁移 API 单测
 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  getEffectiveContent,
  importPack,
  listLegacySemanticsPacks,
  listPackItems,
  replacePackContent,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function makePack(
  items: PackItemV1[],
  meta: Record<string, unknown> = {},
): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'semantics' as const,
    createdAt: Date.UTC(2026, 11, 12),
    generator: 'test@pack-migration',
    items,
    meta: { source: 'import' as const, ...meta },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

function oldItem(): PackItemV1 {
  return {
    headword: 'domain',
    headwordLower: 'domain',
    coreSenses: [{ index: 1, label: '领域义的网络化', note: '旧 v3 链上括号', confidence: 'low' }],
    meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1, steps: ['看是否指领域', '网络化'] }],
  }
}

function v4Item(): PackItemV1 {
  return {
    headword: 'domain',
    headwordLower: 'domain',
    coreSenses: [
      { index: 1, label: '领域', note: '活动或知识的范围', origin: '拉丁 dominium=领地', confidence: 'high' },
      { index: 2, label: '领地', note: '占有的土地范围', confidence: 'medium' },
    ],
    meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
  }
}

describe('task-99 · replacePackContent 迁移', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('旧 v3 pack 可被列出；替换后旧 pack 删除、新 v4 生效、effective 内容更新', async () => {
    const deck = await createDeck({
      name: '迁移词库',
      words: [{ headword: 'domain', meanings: [{ pos: 'n.', cn: '领域；领地' }] }],
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()

    const oldFile = await makePack([oldItem()], { promptVersion: 'v3.7-semantics', deckId: deck.id })
    const oldImported = await importPack(JSON.stringify(oldFile))
    expect(oldImported.packId).toBeDefined()
    const oldItems = await listPackItems(oldImported.packId!)
    await approveItems(oldImported.packId!, oldItems.map((item) => item.id))
    await applyApproved(oldImported.packId!)
    const legacyBefore = await listLegacySemanticsPacks()
    expect(legacyBefore.some((pack) => pack.id === oldImported.packId)).toBe(true)
    expect((await getEffectiveContent(`${deck.id}:domain`, `${deck.id}:domain#M1`))!.meaning!.coreSense!.label).toBe(
      '领域义的网络化',
    )

    const newFile = await makePack([v4Item()], { promptVersion: 'v4.0-semantics-grouped', deckId: deck.id })
    const result = await replacePackContent(oldImported.packId!, JSON.stringify(newFile))
    expect(result.removedOld).toBe(true)
    expect(result.applied).toBe(1)
    expect(await db.packs.get(oldImported.packId!)).toBeUndefined()
    expect(await db.packs.get(result.newPackId)).toBeTruthy()

    const effective = (await getEffectiveContent(`${deck.id}:domain`, `${deck.id}:domain#M1`))!
    expect(effective.meaning!.coreSense!.label).toBe('领域')
    expect(effective.meaning!.coreSense!.origin).toBe('拉丁 dominium=领地')
    const legacyAfter = await listLegacySemanticsPacks()
    expect(legacyAfter.some((pack) => pack.id === result.newPackId)).toBe(false)
  })

  it('新包与旧包 checksum 相同 → 报错且不删除旧 pack', async () => {
    const deck = await createDeck({
      name: '迁移同包',
      words: [{ headword: 'domain', meanings: [{ pos: 'n.', cn: '领域' }] }],
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const oldFile = await makePack([oldItem()], { promptVersion: 'v3.7-semantics', deckId: deck.id })
    const imported = await importPack(JSON.stringify(oldFile))
    await expect(replacePackContent(imported.packId!, JSON.stringify(oldFile))).rejects.toThrow(/相同/)
    expect(await getDb().packs.get(imported.packId!)).toBeTruthy()
  })
})
