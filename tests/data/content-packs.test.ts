import './test-utils'

import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'

import { AppDatabase, createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  clearRejects,
  deletePack,
  ensureBuiltinDecks,
  exportPack,
  getEffectiveContent,
  getPackStats,
  exportMigration,
  importMigration,
  importPack,
  listPackItems,
  listPacks,
  parsePackFile,
  pendingGenerationTargets,
  reapplyAppliedPacks,
  rejectItems,
  selectTargets,
} from '../../src/data'
import { BRAND } from '../../src/app/brand'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackKind } from '../../src/data'
import type { PackItemV1 } from '../../src/data/packs/schema'
import { localDateKey, meaningIdOf } from '../../src/core'

const NOW = new Date(2026, 11, 5, 10, 0, 0).getTime()

async function makePack(items: PackItemV1[], kind: PackKind = 'mixed', extras: Partial<PackFileV1> = {}): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind,
    createdAt: NOW,
    generator: 'test@1',
    items,
    ...extras,
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

async function setupDeck() {
  const deck = await createDeck({
    name: '内容包测试词库',
    words: [
      { headword: 'abdomen', meanings: [{ pos: 'n.', cn: '腹部' }, { pos: 'n.', cn: '下腹' }] },
      { headword: 'abstract', meanings: [{ pos: 'adj.', cn: '抽象的' }] },
      { headword: 'zebra', meanings: [{ pos: 'n.', cn: '斑马' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

async function importApproveApply(file: PackFileV1) {
  const imported = await importPack(JSON.stringify(file))
  expect(imported.ok, imported.issues.map((issue) => issue.message).join('; ')).toBe(true)
  const items = await listPackItems(imported.packId!)
  const pending = items.filter((item) => item.status === 'pending').map((item) => item.id)
  expect(pending.length).toBeGreaterThan(0)
  await approveItems(imported.packId!, pending)
  const applied = await applyApproved(imported.packId!)
  return { packId: imported.packId!, applied, imported }
}

beforeEach(async () => {
  await resetDatabase()
})

describe('内容包（momo-pack v1）数据层：解析/校验 (AC1)', () => {
  it('合法 pack 可解析；checksum 被篡改 → E_CHECKSUM 且不写库', async () => {
    await setupDeck()
    const file = await makePack([
      { headword: 'abdomen', headwordLower: 'abdomen', examples: [{ en: 'Lower abdomen pain.', cn: '下腹疼痛。' }] },
    ])
    const parsed = await parsePackFile(JSON.stringify(file))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.items).toHaveLength(1)

    const tampered = { ...file, checksum: '0'.repeat(64) }
    const imported = await importPack(JSON.stringify(tampered))
    expect(imported.ok).toBe(false)
    expect(imported.issues.some((issue) => issue.code === 'E_CHECKSUM')).toBe(true)
    expect((await getPackStats()).packs).toBe(0)

    const badJson = await importPack('not-json')
    expect(badJson.ok).toBe(false)
    expect(badJson.issues.some((issue) => issue.code === 'E_FORMAT')).toBe(true)
  })
})

describe('导入 → 审核 → 应用 (AC2/AC3/AC4/AC5/AC10)', () => {
  it('只补缺 + 去重 + 重复导入/重复应用幂等', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const word = (await db.words.get(`${deck.id}:abdomen`))!
    // 已有同 en 例句（应 skipped:duplicate，不重复写）
    await db.words.put({ ...word, examples: [{ en: 'Existing example.', cn: '已有例句。' }] })

    const file = await makePack([
      {
        headword: 'abdomen',
        headwordLower: 'abdomen',
        examples: [
          { en: 'Existing example.', cn: '已有例句。' },
          { en: 'He felt pain in his lower abdomen.', cn: '他感到下腹疼痛。' },
        ],
      },
    ])
    const { packId, applied } = await importApproveApply(file)
    expect(applied.applied).toBe(1)
    expect(applied.skippedDetails.some((skip) => skip.reason === 'duplicate')).toBe(true)
    const after = (await db.words.get(`${deck.id}:abdomen`))!
    expect(after.examples.map((example) => example.en)).toEqual(['Existing example.', 'He felt pain in his lower abdomen.'])

    // task-92：重复导入同一 pack → 按 checksum 复用已有 pack（不再新建/不产生重复）
    const packsBefore = await db.packs.count()
    const again = await importPack(JSON.stringify(file))
    expect(again.ok).toBe(true)
    expect(again.reused).toBe(true)
    expect(again.packId).toBe(packId)
    expect(again.issues.some((issue) => issue.code === 'E_DUP')).toBe(true)
    expect(await db.packs.count()).toBe(packsBefore)

    // 重复 apply 不会重复写
    const reapply = await applyApproved(packId)
    expect(reapply.applied).toBe(0)
    expect((await db.words.get(`${deck.id}:abdomen`))!.examples).toHaveLength(2)
  })

  it('unknown word / meaningIndex 越界 → skipped 报告（不阻断）', async () => {
    const deck = await setupDeck()
    const file = await makePack([
      { headword: 'zzzz-not-exist', headwordLower: 'zzzz-not-exist', examples: [{ en: 'x', cn: 'y' }] },
      { headword: 'abdomen', headwordLower: 'abdomen', meaningIndex: 9, examples: [{ en: 'x', cn: 'y' }] },
    ])
    const imported = await importPack(JSON.stringify(file))
    expect(imported.ok).toBe(true)
    // task-142：内容条目 meaningIndex 超范围 → 降级为词级 pending（不再整条 skipped）；
    // 仅「词不在词库」保留 unknown-word skipped。
    expect(imported.preview.counts.matched).toBe(1)
    expect(imported.preview.skipped.map((skip) => skip.reason).sort()).toEqual(['unknown-word'])
    expect(imported.packId).toBeDefined()
    const importedItems = await listPackItems(imported.packId!)
    expect(importedItems.map((item) => item.status).sort()).toEqual(['pending', 'skipped'])
    const word = await getDb().words.get(`${deck.id}:abdomen`)
    expect(word!.examples).toHaveLength(0)
  })

  it('上限截断：词级例句 ≤8、助记 ≤4、词组 ≤8，都有 skipped:limit', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const word = (await db.words.get(`${deck.id}:abstract`))!
    await db.words.put({
      ...word,
      examples: Array.from({ length: 6 }, (_, i) => ({ en: `old ${i}`, cn: `旧${i}` })),
      mnemonics: Array.from({ length: 4 }, (_, i) => ({ type: '联想' as const, text: `旧助记${i}` })),
      phrases: Array.from({ length: 8 }, (_, i) => ({ en: `old phrase ${i}`, cn: `旧词组${i}` })),
    })
    const file = await makePack([
      {
        headword: 'abstract',
        examples: Array.from({ length: 5 }, (_, i) => ({ en: `new ${i}`, cn: `新${i}` })),
        mnemonics: [{ type: '联想', text: '新助记' }],
        phrases: [{ en: 'new phrase', cn: '新词组' }],
      },
    ])
    const { applied } = await importApproveApply(file)
    const after = (await db.words.get(`${deck.id}:abstract`))!
    expect(after.examples).toHaveLength(8) // 6 + 2（上限 8）
    expect(after.mnemonics).toHaveLength(4)
    expect(after.phrases).toHaveLength(8)
    expect(applied.skippedDetails.some((skip) => skip.reason === 'limit')).toBe(true)
  })

  it('❌ 写拒绝记忆；再次导入同内容 skipped:rejected；清空拒绝后可再导入', async () => {
    const deck = await setupDeck()
    const file = await makePack([
      { headword: 'zebra', headwordLower: 'zebra', mnemonics: [{ type: '词根', text: 'zebra 斑马联想' }] },
    ])
    const imported = await importPack(JSON.stringify(file))
    const pending = await listPackItems(imported.packId!)
    await rejectItems(imported.packId!, [pending[0]!.id])
    expect((await getPackStats()).rejects).toBeGreaterThan(0)

    // 删除该 pack 后重新导入（无同 checksum 可复用）→ 拒绝记忆生效
    await deletePack(imported.packId!)
    const again = await importPack(JSON.stringify(file))
    expect(again.reused).toBeFalsy()
    expect(again.preview.matched).toHaveLength(0)
    expect(again.preview.skipped.some((skip) => skip.reason === 'rejected')).toBe(true)

    expect(await clearRejects()).toBeGreaterThan(0)
    const third = await importPack(JSON.stringify(file))
    expect(third.preview.matched).toHaveLength(1)
    const word = await getDb().words.get(`${deck.id}:zebra`)
    expect(word!.mnemonics).toHaveLength(0) // 未 apply 不落库
  })

  it('导出 → 重新导入 round-trip；删除包默认保留内容', async () => {
    const deck = await setupDeck()
    const file = await makePack([
      {
        headword: 'abdomen',
        examples: [{ en: 'The abdomen is tender.', cn: '腹部有压痛。' }],
        mnemonics: [{ type: '词根', text: 'abdo- 腹部' }],
      },
    ])
    const { packId } = await importApproveApply(file)
    const blob = await exportPack(packId)
    const text = await blob.text()
    const exported = JSON.parse(text) as PackFileV1
    expect(exported.format).toBe('momo-pack')
    expect(exported.items.length).toBeGreaterThan(0)
    expect(exported.meta?.createdBy).toBe(BRAND.name) // 品牌不硬编码（公开树 brand 测试）
    expect((await parsePackFile(text)).ok).toBe(true)

    const reimport = await importPack(text)
    expect(reimport.preview.matched).toHaveLength(0)
    expect(reimport.packId).toBeUndefined()

    await deletePack(packId)
    expect(await listPacks()).toHaveLength(0)
    const word = await getDb().words.get(`${deck.id}:abdomen`)
    expect(word!.examples.length).toBeGreaterThan(0)
    expect(word!.mnemonics.length).toBeGreaterThan(0)
  })

  it('getEffectiveContent：Word 内容 + 已应用条目合并（重种后仍可读）', async () => {
    const deck = await setupDeck()
    const file = await makePack([
      { headword: 'zebra', examples: [{ en: 'A zebra has stripes.', cn: '斑马有条纹。' }] },
    ])
    const { packId } = await importApproveApply(file)
    const db = getDb()
    const wordId = `${deck.id}:zebra`
    let effective = await getEffectiveContent(wordId)
    expect(effective!.examples.map((example) => example.en)).toContain('A zebra has stripes.')

    const word = (await db.words.get(wordId))!
    await db.words.put({ ...word, examples: [] })
    effective = await getEffectiveContent(wordId)
    expect(effective!.examples.map((example) => example.en)).toContain('A zebra has stripes.')
    const rp = await reapplyAppliedPacks()
    expect(rp.items).toBeGreaterThanOrEqual(1)
    expect((await db.words.get(wordId))!.examples.length).toBeGreaterThan(0)
    expect(packId).toBeTruthy()
  })
})

describe('AI 生成条目兼容（task-70）', () => {
  it('英文助记类型 root/assoc/story 落库时映射为中文枚举', async () => {
    await setupDeck()
    const file = await makePack([
      {
        headword: 'zebra',
        mnemonics: [
          { type: 'root', text: 'zebr- 词根联想' },
          { type: 'assoc', text: '斑马线联想' },
          { type: 'story', text: '故事串记' },
        ],
      },
    ])
    await importApproveApply(file)
    const zebra = (await getDb().words.toArray()).find((item) => item.headwordLower === 'zebra')!
    expect(zebra.mnemonics.map((mnemonic) => mnemonic.type)).toEqual(['词根', '联想', '串记'])
  })
})

describe('AI 生成条目的直接拒绝 + 隐私（task-71）', () => {
  it('rejectGeneratedItem 只写拒绝记忆，不建 pack；同内容再次导入被拒绝', async () => {
    await setupDeck()
    const { rejectGeneratedItem } = await import('../../src/data')
    const item = { headword: 'zebra', headwordLower: 'zebra', examples: [{ en: 'Zebra crossing.', cn: '斑马线。' }] }
    expect(await rejectGeneratedItem(item)).toBeGreaterThan(0)
    expect((await getPackStats()).packs).toBe(0)
    const file = await makePack([item])
    const imported = await importPack(JSON.stringify(file))
    expect(imported.preview.matched).toHaveLength(0)
    expect(imported.preview.skipped.some((skip) => skip.reason === 'rejected')).toBe(true)
  })
})

describe('隐私（task-69/70）：敏感 Key 不进迁移包', () => {
  it('exportMigration 不含 ai.apiKey / maimemoToken', async () => {
    const db = getDb()
    await db.settings.bulkPut([
      { key: 'ai.apiKey', value: 'sk-secret-test', updatedAt: NOW },
      { key: 'data.maimemoToken', value: 'momo-secret-test', updatedAt: NOW },
    ])
    const text = await (await exportMigration()).text()
    expect(text).not.toContain('sk-secret-test')
    expect(text).not.toContain('momo-secret-test')
  })
})

describe('范围选择 + 排除条件 (AC7)', () => {
  it('today/deck/meaning 范围与「已有内容/已拒绝」排除', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const [abdomen, abstract, zebra] = await Promise.all([
      db.words.get(`${deck.id}:abdomen`),
      db.words.get(`${deck.id}:abstract`),
      db.words.get(`${deck.id}:zebra`),
    ])
    await db.words.put({ ...abdomen!, examples: [{ en: 'existing', cn: '已有' }] })
    await db.words.put({
      ...abstract!,
      phrases: [{ en: 'abstract concept', cn: '抽象概念', meaningId: meaningIdOf(abstract!.id, 1) }],
    })

    const date = localDateKey(Date.now())
    await db.plans.put({
      id: `${date}:${deck.id}`,
      date,
      deckId: deck.id,
      wordIds: [abdomen!.id, abstract!.id, zebra!.id],
      index: 0,
      sources: {},
      goals: { dailyGoal: 3, dueCount: 0, newBudget: 3, extraCount: 0 },
      ratings: [],
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
    })

    // today + examples：abdomen 已有例句被排除；abstract/zebra 入选
    const todayTargets = await selectTargets({ kind: 'today' }, 'examples')
    expect(todayTargets.map((target) => target.headword).sort()).toEqual(['abstract', 'zebra'])

    const all = await selectTargets({ kind: 'today' }, 'examples', { excludeExisting: false, missingOnly: false })
    expect(all).toHaveLength(3)

    // meaning scope phrases：abstract 含义1 已有词组 → 排除；abdomen 含义2 无 → 入选
    const meaning1 = await selectTargets(
      { kind: 'meaning', wordId: abstract!.id, meaningId: meaningIdOf(abstract!.id, 1) },
      'phrases',
    )
    expect(meaning1).toHaveLength(0)
    const meaning2 = await pendingGenerationTargets(
      { kind: 'meaning', wordId: abdomen!.id, meaningId: meaningIdOf(abdomen!.id, 2) },
      'phrases',
    )
    expect(meaning2).toHaveLength(1)
    expect(meaning2[0]!.meaningIndex).toBe(2)
    expect(meaning2[0]!.meaningId).toBe(meaningIdOf(abdomen!.id, 2))

    // deck scope：过滤后分页（abdomen 被排除，abstract/zebra 剩 2）
    const page = await selectTargets({ kind: 'deck', deckId: deck.id, offset: 0, limit: 2 }, 'examples')
    expect(page.map((target) => target.headword).sort()).toEqual(['abstract', 'zebra'])

    // 已拒绝 → 排除
    const file = await makePack([{ headword: 'zebra', mnemonics: [{ type: '联想', text: '斑马助记' }] }])
    const imported = await importPack(JSON.stringify(file))
    const pending = await listPackItems(imported.packId!)
    await rejectItems(imported.packId!, pending.map((item) => item.id))
    const afterReject = await selectTargets({ kind: 'word', wordId: zebra!.id }, 'mnemonics')
    expect(afterReject).toHaveLength(0)
  })
})

describe('迁移包携带内容包（SPEC §3.4 / D5）', () => {
  it('exportMigration 含 contentPacks/packItems/contentRejects；replace 导入后恢复；空库导出不含该字段', async () => {
    await setupDeck()
    const file = await makePack([
      { headword: 'zebra', examples: [{ en: 'Migrate zebra.', cn: '迁移例句。' }] },
    ])
    const { packId } = await importApproveApply(file)
    const { rejectGeneratedItem } = await import('../../src/data')
    await rejectGeneratedItem({
      headword: 'zebra',
      headwordLower: 'zebra',
      phrases: [{ en: 'zebra phrase', cn: '斑马词组' }],
    })

    const text = await (await exportMigration()).text()
    expect(text).toContain('"contentPacks"')
    expect(text).toContain('"packItems"')
    expect(text).toContain('"contentRejects"')

    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    const db = getDb()
    expect(await db.packs.count()).toBe(1)
    expect(await db.packItems.count()).toBeGreaterThan(0)
    expect(await db.contentRejects.count()).toBeGreaterThan(0)
    const pack = (await db.packs.get(packId!))!
    expect(pack.status).toBe('applied')
    const word = (await db.words.toArray()).find((item) => item.headwordLower === 'zebra')!
    expect(word.examples.some((example) => example.en === 'Migrate zebra.')).toBe(true)

    // 空库导出（无内容包）不含新字段 → 旧包/新包互相兼容
    await resetDatabase()
    const emptyText = await (await exportMigration()).text()
    expect(emptyText).not.toContain('"contentPacks"')
    const emptyReport = await importMigration(emptyText, { strategy: 'replace' })
    expect(emptyReport.ok).toBe(true)
  }, 120_000)
})

describe('v2 → v3 迁移 + 重种重放 (AC6)', () => {
  it('旧 v2 库打开后自动建 packs/packItems/contentRejects，旧 plans 数据保留', async () => {
    const name = `momo-v2-migration-${Date.now()}`
    const old = new Dexie(name)
    old.version(2).stores({
      decks: 'id, name, source, builtinKey, updatedAt',
      words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt',
      states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
      reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
      settings: 'key',
      meta: 'key',
      plans: 'id, date, deckId, updatedAt, completedAt',
    })
    await old.open()
    await old.table('plans').put({
      id: '2026-12-05:d',
      date: '2026-12-05',
      deckId: 'd',
      wordIds: ['d:a'],
      index: 0,
      sources: {},
      goals: { dailyGoal: 1, dueCount: 0, newBudget: 1, extraCount: 0 },
      ratings: [],
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
    })
    old.close()

    const upgraded = new AppDatabase(name)
    await upgraded.open()
    try {
      expect(upgraded.tables.map((table) => table.name)).toEqual(
        expect.arrayContaining(['packs', 'packItems', 'contentRejects', 'plans']),
      )
      expect(await upgraded.table('plans').count()).toBe(1)
      await upgraded.packs.put({
        id: 'pk_migration_test',
        name: '迁移校验',
        kind: 'examples',
        formatVersion: 1,
        checksum: 'x'.repeat(64),
        source: 'import',
        status: 'empty',
        counts: { items: 0, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 0 },
        createdAt: 1,
        updatedAt: 1,
      })
      expect(await upgraded.packs.count()).toBe(1)
      await upgraded.writeSchemaMeta()
      expect((await upgraded.meta.get('schemaVersion'))!.value).toBe(3)
    } finally {
      upgraded.close()
      await Dexie.delete(name)
    }
  })

  it('builtin 重种（force reseed）后已应用内容仍在（reapply 集成）', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const { getSettings } = await import('../../src/data')
    const selectedDeckId = (await getSettings())['data.selectedDeckId']
    const word = await db.words.where('deckId').equals(selectedDeckId).first()
    const marker = `pack-example-${Date.now()}`
    const file = await makePack([
      {
        headword: word!.headword,
        headwordLower: word!.headwordLower,
        examples: [{ en: `${marker} about ${word!.headword}.`, cn: '内容包例句' }],
      },
    ])
    await importApproveApply(file)
    expect((await db.words.get(word!.id))!.examples.some((example) => example.en.includes(marker))).toBe(true)
    // force reseed：替换整个 builtin 词表，内部自动 reapply 已应用内容
    const seeded = await ensureBuiltinDecks({ force: true })
    expect(seeded.seeded.length).toBeGreaterThan(0)
    const after = (await db.words.get(word!.id))!
    expect(after.examples.some((example) => example.en.includes(marker))).toBe(true)
  }, 120_000)
})
