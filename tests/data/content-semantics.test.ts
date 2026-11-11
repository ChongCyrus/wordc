import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  exportPack,
  getEffectiveContent,
  importPack,
  listPackItems,
  parsePackFile,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1, PackKind } from '../../src/data'

const NOW = new Date(2026, 11, 8, 10, 0, 0).getTime()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function makePack(items: PackItemV1[], kind: PackKind = 'semantics', extras: Partial<PackFileV1> = {}): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind,
    createdAt: NOW,
    generator: 'test@semantics',
    items,
    meta: { source: 'ai' as const },
    ...extras,
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

async function setupDeck() {
  const deck = await createDeck({
    name: '语义测试词库',
    words: [
      {
        headword: 'bank',
        meanings: [
          { pos: 'n.', cn: '银行' },
          { pos: 'n.', cn: '河岸' },
          { pos: 'vt.', cn: '储存' },
        ],
      },
      { headword: 'single', meanings: [{ pos: 'adj.', cn: '单一的' }] },
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
  return { packId: imported.packId!, applied }
}

beforeEach(async () => {
  await resetDatabase()
})

describe('语义扩展（task-75）：解析/校验', () => {
  it('kind=semantics + coreSenses/meaningMap 可解析；checksum 篡改拒绝', async () => {
    const file = await makePack([
      {
        headword: 'bank',
        coreSenses: [
          { index: 1, label: '握住', origin: '本义', confidence: 'high' },
          { index: 2, label: '容器', note: '引申' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 2, note: '由容器引申' },
        ],
      },
    ])
    const parsed = await parsePackFile(JSON.stringify(file))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.kind).toBe('semantics')
      expect(parsed.value.items[0]!.coreSenses).toHaveLength(2)
      expect(parsed.value.items[0]!.coreSenses![1]!.confidence).toBeUndefined() // 缺失兼容
    }
    const tampered = { ...file, checksum: 'f'.repeat(64) }
    expect((await parsePackFile(JSON.stringify(tampered))).ok).toBe(false)

    // 非法 confidence 值 → schema 拒绝
    const badConfidence = {
      ...file,
      items: [{ headword: 'bank', coreSenses: [{ index: 1, label: 'x', confidence: 'highx' }] }],
    }
    expect((await parsePackFile(JSON.stringify(badConfidence))).ok).toBe(false)
  })
})

describe('语义扩展：应用与 getEffectiveContent', () => {
  it('应用后返回 coreSenses + 当前含义映射（含 AI 来源/confidence/无 confidence）', async () => {
    await setupDeck()
    const file = await makePack([
      {
        headword: 'bank',
        coreSenses: [
          { index: 1, label: '握住', origin: '本义', confidence: 'high' },
          { index: 2, label: '容器' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 2, note: '由容器引申' },
          { meaningIndex: 3, coreSenseIndex: 2 },
        ],
      },
    ])
    const { applied } = await importApproveApply(file)
    expect(applied.applied).toBe(1)

    const db = getDb()
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!
    expect(bank.meanings).toHaveLength(3) // 语义不改词条
    const effective = await getEffectiveContent(bank.id)
    expect(effective!.coreSenses.map((sense) => sense.label)).toEqual(['握住', '容器'])
    expect(effective!.coreSenses[0]!.confidence).toBe('high')
    expect(effective!.coreSenses[0]!.source).toBe('ai')
    expect(effective!.coreSenses[1]!.confidence).toBeUndefined()
    expect(effective!.meaningMap).toHaveLength(3)

    const m1 = await getEffectiveContent(bank.id, `${bank.id}#M1`)
    expect(m1!.meaning).toMatchObject({ meaningIndex: 1, coreSenseIndex: 1, coreSense: { label: '握住' } })
    expect(m1!.meaning!.coreSense!.source).toBe('ai')
    const m3 = await getEffectiveContent(bank.id, `${bank.id}#M3`)
    expect(m3!.meaning).toMatchObject({ meaningIndex: 3, coreSenseIndex: 2, coreSense: { label: '容器' } })
    expect(m3!.meaning!.note).toBeUndefined()
  })

  it('多包合并：coreSenses 按 label 去重（首个生效）、meaningMap 只补缺不覆盖', async () => {
    await setupDeck()
    const db = getDb()
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!

    const pack1 = await makePack([
      {
        headword: 'bank',
        coreSenses: [
          { index: 1, label: '握住', confidence: 'high', origin: '本义' },
          { index: 2, label: '容器', confidence: 'medium' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 1, note: 'pack1 映射' },
        ],
      },
    ])
    await importApproveApply(pack1)
    await wait(5)
    const pack2 = await makePack([
      {
        headword: 'bank',
        coreSenses: [
          { index: 1, label: '握住', confidence: 'low' }, // 重复 label → 丢弃
          { index: 2, label: '河岸' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 2, note: 'pack2 想覆盖应被忽略' },
          { meaningIndex: 2, coreSenseIndex: 2, note: 'pack2 也应保留 pack1' },
          { meaningIndex: 3, coreSenseIndex: 2, note: '补齐缺失映射' },
        ],
      },
    ])
    await importApproveApply(pack2)

    const effective = await getEffectiveContent(bank.id)
    expect(effective!.coreSenses.map((sense) => sense.label)).toEqual(['握住', '容器', '河岸'])
    expect(effective!.coreSenses[0]!.confidence).toBe('high') // 首个生效
    expect(effective!.meaningMap.map((mapping) => [mapping.meaningIndex, mapping.coreSenseIndex])).toEqual([
      [1, 1],
      [2, 1],
      [3, 3],
    ])
    expect(effective!.meaningMap[0]!.note).toBeUndefined() // pack1 无 note
    expect(effective!.meaningMap[2]!.note).toBe('补齐缺失映射')
  })

  it('多步本义链：meaningMap.steps 原样返回；后续包可补齐缺失链（不覆盖已有链）', async () => {
    await setupDeck()
    const db = getDb()
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!
    const pack1 = await makePack([
      {
        headword: 'bank',
        coreSenses: [
          { index: 1, label: '一起吃饭的人', origin: '本义' },
          { index: 2, label: '公司', origin: '引申' },
        ],
        meaningMap: [
          {
            meaningIndex: 2,
            coreSenseIndex: 2,
            steps: ['一起吃饭的人', '一起做事的人', '公司'],
          },
          { meaningIndex: 1, coreSenseIndex: 1 }, // 无 steps：后续包可补
        ],
      },
    ])
    await importApproveApply(pack1)
    let effective = await getEffectiveContent(bank.id, `${bank.id}#M2`)
    expect(effective!.meaning!.steps).toEqual(['一起吃饭的人', '一起做事的人', '公司'])
    expect(effective!.meaningMap.find((mapping) => mapping.meaningIndex === 2)!.steps).toHaveLength(3)
    expect(effective!.meaningMap.find((mapping) => mapping.meaningIndex === 1)!.steps).toBeUndefined()

    await wait(5)
    const pack2 = await makePack([
      {
        headword: 'bank',
        coreSenses: [{ index: 1, label: '一起吃饭的人' }],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1, steps: ['一起吃饭的人', '一起做事的人'] }, // 补链
          { meaningIndex: 2, coreSenseIndex: 1, steps: ['不应覆盖已有链'] },
        ],
      },
    ])
    await importApproveApply(pack2)
    effective = await getEffectiveContent(bank.id, `${bank.id}#M1`)
    expect(effective!.meaning!.steps).toEqual(['一起吃饭的人', '一起做事的人'])
    const m2 = await getEffectiveContent(bank.id, `${bank.id}#M2`)
    expect(m2!.meaning!.steps).toEqual(['一起吃饭的人', '一起做事的人', '公司']) // 已有链保留
  })

  it('无映射回退：只有 coreSenses、无 meaningMap → 当前含义无映射但本义可用', async () => {
    await setupDeck()
    const db = getDb()
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!
    const file = await makePack([
      {
        headword: 'bank',
        coreSenses: [{ index: 1, label: '握住', note: '仅本义' }],
      },
    ])
    await importApproveApply(file)
    const effective = await getEffectiveContent(bank.id, `${bank.id}#M2`)
    expect(effective!.coreSenses.map((sense) => sense.label)).toEqual(['握住'])
    expect(effective!.meaningMap).toEqual([])
    expect(effective!.meaning).toBeUndefined() // UI 回退不展示
  })

  it('非法映射：meaningIndex 越界 → skipped:unknown-meaning；coreSenseIndex 不存在 → invalid', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!
    expect(bank.deckId).toBe(deck.id)
    const file = await makePack([
      { headword: 'bank', coreSenses: [{ index: 1, label: '握住' }], meaningMap: [{ meaningIndex: 9, coreSenseIndex: 1 }] },
      { headword: 'bank', coreSenses: [{ index: 1, label: '容器' }], meaningMap: [{ meaningIndex: 1, coreSenseIndex: 7 }] },
    ])
    const imported = await importPack(JSON.stringify(file))
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    const applied = await applyApproved(imported.packId!)
    expect(applied.applied).toBe(0)
    expect(applied.skipped).toBe(2)
    expect(applied.skippedDetails.map((detail) => detail.reason).sort()).toEqual(['invalid', 'unknown-meaning'])
    const statuses = (await listPackItems(imported.packId!)).map((item) => item.status).sort()
    expect(statuses).toEqual(['skipped', 'skipped'])
  })

  it('导出 round-trip：导出包含 coreSenses/meaningMap 且 checksum 通过；重新导入不重复', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!
    void deck
    const file = await makePack([
      {
        headword: 'bank',
        coreSenses: [{ index: 1, label: '握住' }, { index: 2, label: '容器' }],
        meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
      },
    ])
    const { packId } = await importApproveApply(file)
    const text = await (await exportPack(packId)).text()
    const parsed = await parsePackFile(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.items[0]!.coreSenses).toHaveLength(2)
      expect(parsed.value.items[0]!.meaningMap).toHaveLength(1)
    }
    const reimport = await importPack(text)
    expect(reimport.preview.matched).toHaveLength(0) // contentHash 重复
    const effective = await getEffectiveContent(bank.id, `${bank.id}#M1`)
    expect(effective!.meaning!.coreSense!.label).toBe('握住')
  })

  it('mixed pack：语义 + 例句同时应用（例句落 Word，语义进 effective）', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!
    const file = await makePack(
      [
        {
          headword: 'bank',
          coreSenses: [{ index: 1, label: '握住' }],
          meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
          examples: [{ en: 'A bank of the river.', cn: '河岸。' }],
        },
      ],
      'mixed',
    )
    const { applied } = await importApproveApply(file)
    expect(applied.applied).toBe(1)
    const after = (await db.words.get(bank.id))!
    expect(after.examples.some((example) => example.en === 'A bank of the river.')).toBe(true)
    const effective = await getEffectiveContent(bank.id, `${bank.id}#M1`)
    expect(effective!.meaning!.coreSense!.label).toBe('握住')
    void deck
  })

  it('单含义词无语义数据 → effective 回退为空（不自映射不造假）', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const single = (await db.words.toArray()).find((word) => word.headwordLower === 'single')!
    const effective = await getEffectiveContent(single.id, `${single.id}#M1`)
    expect(effective!.coreSenses).toEqual([])
    expect(effective!.meaningMap).toEqual([])
    expect(effective!.meaning).toBeUndefined()
    expect(single.deckId).toBe(deck.id)
  })
})
