import './test-utils'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  getEffectiveContent,
  importPack,
  listPackItems,
  reapplyPack,
} from '../../src/data'
// @ts-expect-error tools/lib 为 .mjs 纯 helper，无 TS 类型
import { buildPackFromEntries } from '../../tools/normalize-external-pack.mjs'
import { computeChecksum } from '../../src/data/checksum'
import { dedupePacks, deletePack, deletePacks } from '../../src/data'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function makePack(
  items: PackItemV1[],
  kind: PackFileV1['kind'] = 'semantics',
  meta: Record<string, unknown> = {},
): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind,
    createdAt: Date.UTC(2026, 11, 10),
    generator: 'test@deck-conflict',
    items,
    meta: { source: 'import' as const, ...meta },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

/** 同一 headword 'embrace' 在两个 deck：大纲 1 个含义 / 受限商业词表 4 个含义（meaningIndex=2 只在受限商业词表有效） */
async function setupConflictDecks() {
  const dagang = await createDeck({
    name: '冲突-大纲',
    words: [{ headword: 'embrace', meanings: [{ pos: 'v.', cn: '拥抱' }] }],
  })
  const hong = await createDeck({
    name: '冲突-受限商业词表',
    words: [
      {
        headword: 'embrace',
        meanings: [
          { pos: 'v.', cn: '拥抱' },
          { pos: 'v.', cn: '信奉' },
          { pos: 'v.', cn: '包含' },
          { pos: 'n.', cn: '拥抱（名词）' },
        ],
      },
      // 仅受限商业词表存在的词：用于「packDeckId 不存在 → 回退任意 deck」的 CI 稳定断言
      {
        headword: 'solitary',
        meanings: [
          { pos: 'adj.', cn: '孤独的' },
          { pos: 'adj.', cn: '独自的' },
        ],
      },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': dagang.id }) // 默认选中大纲（旧行为会误命中）
  return { dagang, hong }
}

function semanticsItem(): PackItemV1 {
  return {
    headword: 'embrace',
    headwordLower: 'embrace',
    meaningIndex: 2,
    coreSenses: [{ index: 1, label: '抱住', confidence: 'high' }],
    meaningMap: [{ meaningIndex: 2, coreSenseIndex: 1 }],
  }
}

beforeEach(async () => {
  await resetDatabase()
})

describe('task-90：normalize --deck 契约', () => {
  it('buildPackFromEntries(deckId) 写入 meta.deckId（checksum 不含 meta）', () => {
    const inputs = [
      {
        file: 'test.jsonl',
        entries: [{ headword: 'embrace', meanings: [{ meaningIndex: 1, cn: '拥抱', coreSenseLabel: '抱住', confidence: 'high' }] }],
      },
    ]
    const res = buildPackFromEntries(inputs, { kind: 'semantics', deckId: 'kaoyan-2027-dagang' })
    expect(res.ok).toBe(true)
    expect(res.pack.meta.deckId).toBe('kaoyan-2027-dagang')
    const withoutDeck = buildPackFromEntries(inputs, { kind: 'semantics' })
    expect(withoutDeck.pack.meta.deckId).toBeUndefined()
    // checksum 不含 meta → 同 items 的 checksum 相同
    expect(withoutDeck.pack.checksum).toBe(res.pack.checksum)
  })
})

describe('task-90：pack.meta.deckId 优先解析（多词库同 headword）', () => {
  it('有 meta.deckId 时优先受限商业词表 deck：meaningIndex=2 不再 unknown-meaning', async () => {
    const { dagang, hong } = await setupConflictDecks()
    const file = await makePack([semanticsItem()], 'semantics', { deckId: hong.id })

    const imported = await importPack(JSON.stringify(file), { resolveAllDecks: true })
    expect(imported.ok).toBe(true)
    expect(imported.preview.matched).toHaveLength(1)
    expect(imported.preview.matched[0]!.wordId).toBe(`${hong.id}:embrace`)
    expect(imported.preview.matched[0]!.deckId).toBe(hong.id)

    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    const applied = await applyApproved(imported.packId!)
    expect(applied.applied).toBe(1)
    expect(applied.skipped).toBe(0)

    const effective = await getEffectiveContent(`${hong.id}:embrace`, `${hong.id}:embrace#M2`)
    expect(effective!.meaning!.coreSense!.label).toBe('抱住')
    // 大纲 deck 的同名词不应被错误写入
    const dagangWord = (await getDb().words.get(`${dagang.id}:embrace`))!
    expect(dagangWord.meanings).toHaveLength(1)
    expect(await getDb().packItems.where('wordId').equals(`${dagang.id}:embrace`).count()).toBe(0)
  })

  it('无 meta.deckId：保持旧行为（选中 deck 优先，meaningIndex 不匹配则 skipped）', async () => {
    const { dagang } = await setupConflictDecks()
    const file = await makePack([semanticsItem()], 'semantics') // 无 deckId
    const imported = await importPack(JSON.stringify(file))
    expect(imported.ok).toBe(true)
    // 未传 resolveAllDecks → 只解析当前选中 deck（大纲，仅 1 个含义）→ unknown-meaning
    expect(imported.preview.matched).toHaveLength(0)
    expect(imported.preview.skipped[0]!.reason).toBe('unknown-meaning')
    expect(dagang.id).toBeTruthy()
  })

  it('dedupePacks：同 checksum 重复包只留一份，删除重复 items，不影响词库内容', async () => {
    const { hong } = await setupConflictDecks()
    const file = await makePack([semanticsItem()], 'semantics', { deckId: hong.id })
    const imported = await importPack(JSON.stringify(file), { resolveAllDecks: true })
    const db = getDb()
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    await applyApproved(imported.packId!)
    const originalPack = (await db.packs.get(imported.packId!))!
    const originalItems = await db.packItems.where('packId').equals(originalPack.id).toArray()

    // 模拟旧版 bug 产生的重复包（同 checksum，新 id + 复制 items）
    const dupId = `${originalPack.id}_dup`
    await db.packs.put({ ...originalPack, id: dupId, createdAt: originalPack.createdAt + 1000 })
    await db.packItems.bulkPut(
      originalItems.map((item, index) => ({
        ...item,
        id: `${dupId}:${index + 1}`,
        packId: dupId,
      })),
    )
    expect(await db.packs.count()).toBe(2)

    const result = await dedupePacks()
    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    expect(await db.packs.count()).toBe(1)
    expect(await db.packItems.where('packId').equals(dupId).count()).toBe(0)
    // 原 pack 与已应用内容保留
    expect(await db.packs.get(originalPack.id)).toBeTruthy()
    const effective = await getEffectiveContent(`${hong.id}:embrace`, `${hong.id}:embrace#M2`)
    expect(effective!.meaning!.coreSense!.label).toBe('抱住')
    // 幂等：再跑不删任何东西
    expect((await dedupePacks()).removed).toBe(0)
  })

  it('deletePack/deletePacks：默认删除包记录但保留已应用词库内容；removeAppliedContent 才回滚内容', async () => {
    const { hong } = await setupConflictDecks()
    const db = getDb()
    const makeMixed = async (word: string, marker = 'delete-test') =>
      makePack(
        [{ headword: word, examples: [{ en: `${word} ${marker} example.`, cn: '删除测试例句' }] }],
        'mixed',
        { deckId: hong.id },
      )

    const fileA = await makeMixed('embrace')
    const fileB = await makeMixed('zebra')
    const importedA = await importPack(JSON.stringify(fileA))
    const importedB = await importPack(JSON.stringify(fileB))
    for (const packId of [importedA.packId!, importedB.packId!]) {
      const items = await listPackItems(packId)
      await approveItems(packId, items.map((item) => item.id))
      await applyApproved(packId)
    }
    expect(await db.packs.count()).toBe(2)

    // 批量删除（默认路径）：pack 全删，已应用内容保留
    const removed = await deletePacks([importedA.packId!, importedB.packId!])
    expect(removed.removed).toBe(2)
    expect(await db.packs.count()).toBe(0)
    expect(await db.packItems.count()).toBe(0)
    expect((await db.words.get(`${hong.id}:embrace`))!.examples.some((example) => example.en.includes('delete-test'))).toBe(
      true,
    )

    // removeAppliedContent：import → apply 后删除，应回滚该包写入的例句（用唯一 en 避免与已保留内容重复）
    const fileC = await makeMixed('embrace', 'rollback-test')
    const importedC = await importPack(JSON.stringify(fileC))
    const itemsC = await listPackItems(importedC.packId!)
    await approveItems(importedC.packId!, itemsC.map((item) => item.id))
    await applyApproved(importedC.packId!)
    const before = (await db.words.get(`${hong.id}:embrace`))!
    expect(before.examples.some((example) => example.en === 'embrace rollback-test example.')).toBe(true)
    await deletePack(importedC.packId!, { removeAppliedContent: true })
    const after = (await db.words.get(`${hong.id}:embrace`))!
    expect(after.examples.some((example) => example.en === 'embrace rollback-test example.')).toBe(false)
  })

  it('deletePack 默认路径不 toArray 全量（1 万条 skipped 包）→ O(1) 内存快速删除', async () => {
    const db = getDb()
    const now = Date.now()
    const packId = 'pk_big_delete_test'
    await db.packs.put({
      id: packId,
      name: '大包删除测试',
      kind: 'mixed',
      formatVersion: 1,
      checksum: 'x'.repeat(64),
      source: 'import',
      status: 'applied',
      counts: { items: 10000, pending: 0, approved: 0, applied: 10000, rejected: 0, skipped: 0 },
      createdAt: now,
      updatedAt: now,
    })
    await db.packItems.bulkPut(
      Array.from({ length: 10_000 }, (_, index) => ({
        id: `${packId}:${index + 1}`,
        packId,
        seq: index + 1,
        headword: `word${index}`,
        headwordLower: `word${index}`,
        payload: { headword: `word${index}`, examples: [{ en: `big ${index}`, cn: '大包' }] },
        status: 'applied' as const,
        contentHashes: [`hash-${index}`],
        createdAt: now,
      })),
    )
    expect(await db.packItems.where('packId').equals(packId).count()).toBe(10_000)

    const toArraySpy = vi.spyOn(db.packItems, 'toArray')
    await deletePack(packId) // 默认 removeAppliedContent=false
    expect(toArraySpy).not.toHaveBeenCalled() // task-94：快路径不读全量
    toArraySpy.mockRestore()
    expect(await db.packs.get(packId)).toBeUndefined()
    expect(await db.packItems.where('packId').equals(packId).count()).toBe(0)
  }, 120_000)

  it('meta.deckId 指向不存在的 deck：resolveAllDecks 时回退到任意 deck（不阻断）', async () => {
    const { hong } = await setupConflictDecks()
    // 用仅存在于受限商业词表的 headword，保证候选唯一（CI/本地一致，不依赖 deck 创建顺序）
    const file = await makePack(
      [
        {
          headword: 'solitary',
          headwordLower: 'solitary',
          meaningIndex: 2,
          coreSenses: [{ index: 1, label: '独自', confidence: 'high' }],
          meaningMap: [{ meaningIndex: 2, coreSenseIndex: 1 }],
        },
      ],
      'semantics',
      { deckId: 'missing-deck' },
    )
    const imported = await importPack(JSON.stringify(file), { resolveAllDecks: true })
    expect(imported.ok).toBe(true)
    expect(imported.preview.matched).toHaveLength(1)
    expect(imported.preview.matched[0]!.wordId).toBe(`${hong.id}:solitary`)
    expect(imported.preview.matched[0]!.deckId).toBe(hong.id)
  })

  it('reapplyPack：旧 pack 因误命中大纲而 skipped 的条目，可指定 deckId 重新应用', async () => {
    const { dagang, hong } = await setupConflictDecks()
    // 旧 pack：无 meta.deckId，导入时按当前选中 deck（大纲）解析 → meaningIndex2 unknown-meaning
    const legacy = await makePack([semanticsItem()], 'semantics')
    const imported = await importPack(JSON.stringify(legacy))
    expect(imported.ok).toBe(true)
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    // 未修复前：该条目以 skipped(unknown-meaning) 落库（不再丢失，供 reapplyPack 重试）
    expect((await listPackItems(imported.packId!))[0]!.status).toBe('skipped')

    // 修复后再应用：指定受限商业词表 deck → 重新解析成功（带进度回调）
    const progress: Array<{ phase: string; done: number; total: number }> = []
    const miao = await reapplyPack(imported.packId!, {
      deckId: hong.id,
      batchSize: 10,
      onProgress: (entry) => progress.push({ phase: entry.phase, done: entry.done, total: entry.total }),
    })
    expect(miao.retried).toBe(1)
    expect(progress.some((entry) => entry.phase === 'resolve' && entry.done === entry.total)).toBe(true)
    expect(progress.some((entry) => entry.phase === 'apply')).toBe(true)
    expect(miao.applied).toBe(1)
    expect(miao.skipped).toBe(0)
    const itemsAfter = await listPackItems(imported.packId!)
    expect(itemsAfter[0]!.status).toBe('applied')
    expect(itemsAfter[0]!.wordId).toBe(`${hong.id}:embrace`)
    const effective = await getEffectiveContent(`${hong.id}:embrace`, `${hong.id}:embrace#M2`)
    expect(effective!.meaning!.coreSense!.label).toBe('抱住')
    // 幂等：再次 reapply 不重复
    const again = await reapplyPack(imported.packId!, { deckId: hong.id })
    expect(again.applied).toBe(0)
    expect(again.retried).toBe(0)
    expect((await getDb().words.get(`${dagang.id}:embrace`))!.meanings).toHaveLength(1)
  })
})
