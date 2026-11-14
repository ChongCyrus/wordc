/** task-146 F8 · Word.derivationMap CRUD / 迁移 / AI apply 不覆盖 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  buildMigrationFile,
  deleteDerivationMap,
  getDerivationMap,
  importMigration,
  importPack,
  listPackItems,
  saveDerivationMap,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'F8 引申图',
    words: [{ headword: 'embrace', meanings: [{ pos: 'v.', cn: '拥抱' }, { pos: 'v.', cn: '包含' }] }],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return { deck, wordId: `${deck.id}:embrace` }
}

async function makePack(items: PackItemV1[], deckId: string): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'mixed' as const,
    createdAt: Date.UTC(2026, 11, 14),
    generator: 'test@f8',
    items,
    meta: { source: 'import' as const, deckId },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

describe('task-146 F8 · derivationMap', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('CRUD：manual/ai source、部分更新保留、删除；不改 packItems/学习进度', async () => {
    const { wordId } = await setup()
    const db = getDb()
    const packCount = await db.packItems.count()
    const stateCount = await db.states.count()

    expect(await getDerivationMap(wordId)).toBeNull()
    const saved = await saveDerivationMap(wordId, {
      rootLabel: '拥抱',
      text: '生成元「拥抱」→ 场景/对象 → 拥抱/包含',
      source: 'manual',
    })
    expect(saved.rootLabel).toBe('拥抱')
    expect(saved.source).toBe('manual')
    expect(saved.updatedAt).toBeGreaterThan(0)
    expect((await getDerivationMap(wordId))?.text).toContain('拥抱/包含')

    // 部分更新：只改 mermaid，保留 rootLabel；source 沿用 manual
    const updated = await saveDerivationMap(wordId, { mermaid: 'mindmap\n  root((拥抱))\n    包含' })
    expect(updated.rootLabel).toBe('拥抱')
    expect(updated.mermaid).toContain('mindmap')
    expect(updated.source).toBe('manual')

    // AI 生成结果保存 → source ai
    const ai = await saveDerivationMap(wordId, { mermaid: 'flowchart LR\n  a-->b', source: 'ai' })
    expect(ai.source).toBe('ai')
    await expect(saveDerivationMap(wordId, { text: '   ' })).resolves.toBeTruthy() // 已有其它字段仍合法
    expect(await deleteDerivationMap(wordId)).toBe(true)
    expect(await deleteDerivationMap(wordId)).toBe(false)
    expect(await getDerivationMap(wordId)).toBeNull()
    await expect(saveDerivationMap(wordId, {})).rejects.toThrow(/不能为空/)
    await expect(saveDerivationMap('missing-word', { text: 'x' })).rejects.toThrow(/不存在/)
    expect(await db.packItems.count()).toBe(packCount)
    expect(await db.states.count()).toBe(stateCount)
  })

  it('迁移导出→清库→导入恢复 derivationMap（source/updatedAt 保留）', async () => {
    const { wordId } = await setup()
    const saved = await saveDerivationMap(wordId, {
      rootLabel: '生成元',
      mermaid: 'mindmap\n  root((生成元))\n    含义一',
      source: 'ai',
    })
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const text = JSON.stringify(file)
    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getWord(wordId))!
    expect(restored.derivationMap?.rootLabel).toBe('生成元')
    expect(restored.derivationMap?.mermaid).toBe(saved.mermaid)
    expect(restored.derivationMap?.source).toBe('ai')
    expect(restored.derivationMap?.updatedAt).toBe(saved.updatedAt)
  })

  it('AI 应用/reapply 内容包不覆盖人工 derivationMap', async () => {
    const { deck, wordId } = await setup()
    const map = await saveDerivationMap(wordId, { rootLabel: '人工生成元', text: '人工内容', source: 'manual' })
    const file = await makePack(
      [{ headword: 'embrace', headwordLower: 'embrace', meaningIndex: 1, examples: [{ en: 'AI example', cn: 'AI 例句' }] }],
      deck.id,
    )
    const imported = await importPack(JSON.stringify(file))
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    await applyApproved(imported.packId!)
    const word = (await getDb().words.get(wordId))!
    expect(word.meanings[0]!.examples?.some((example) => example.en === 'AI example')).toBe(true)
    expect(word.derivationMap).toEqual(map) // 未被 AI 应用覆盖
    // 再次保存人工编辑 → source 仍 manual
    const edited = await saveDerivationMap(wordId, { text: '人工二次编辑' })
    expect(edited.source).toBe('manual')
    expect(edited.rootLabel).toBe('人工生成元')
  })
})
