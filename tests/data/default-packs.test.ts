import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
import {
  DEFAULT_CONTENT_PACKS,
  DEFAULT_PACKS_META_KEY,
  DEFAULT_PACKS_VERSION,
  PRIVATE_CONTENT_PACKS,
  ensureDefaultContentPacks,
  getDefaultContentPacks,
  getEffectiveContent,
  getPackStats,
  isPrivatePacksEnabled,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function makePack(items: PackItemV1[], kind: PackFileV1['kind']): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind,
    createdAt: Date.UTC(2026, 11, 9),
    generator: 'test@default-packs',
    items,
    meta: { source: 'ai' as const, name: `默认包 ${kind}` },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

async function setupDeck() {
  const deck = await createDeck({
    name: '默认包词库',
    words: [
      { headword: 'bank', meanings: [{ pos: 'n.', cn: '银行' }, { pos: 'n.', cn: '河岸' }] },
      { headword: 'zebra', meanings: [{ pos: 'n.', cn: '斑马' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

/** 把两个默认包做成合法 momo-pack 文本（路径 → body） */
/** 私版（受限商业词表）额外两包：语义给 bank、例句给 zebra（仅测试用合成内容） */
async function makePrivateBodies(): Promise<Record<string, string>> {
  const semantics = await makePack(
    [
      {
        headword: 'bank',
        coreSenses: [{ index: 1, label: '受限商业词表本义', origin: '本义', confidence: 'high' }],
        meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
      },
    ],
    'semantics',
  )
  const mixed = await makePack(
    [
      {
        headword: 'zebra',
        examples: [{ en: 'Private pack zebra example.', cn: '私版例句。' }],
      },
    ],
    'mixed',
  )
  const bodies: Record<string, string> = {}
  for (const entry of PRIVATE_CONTENT_PACKS) {
    bodies[`/${entry.path}`] = entry.kind === 'semantics' ? JSON.stringify(semantics) : JSON.stringify(mixed)
  }
  return bodies
}

async function makeBodies(): Promise<Record<string, string>> {
  const semantics = await makePack(
    [
      {
        headword: 'bank',
        coreSenses: [{ index: 1, label: '柜台/长凳', origin: '本义', confidence: 'high' }],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 1 },
        ],
      },
    ],
    'semantics',
  )
  const mixed = await makePack(
    [
      {
        headword: 'zebra',
        examples: [{ en: 'A zebra has black and white stripes.', cn: '斑马有黑白条纹。' }],
        phrases: [{ en: 'zebra crossing', cn: '斑马线' }],
      },
    ],
    'mixed',
  )
  const bodies: Record<string, string> = {}
  for (const entry of DEFAULT_CONTENT_PACKS) {
    bodies[`/${entry.path}`] = entry.kind === 'semantics' ? JSON.stringify(semantics) : JSON.stringify(mixed)
  }
  return bodies
}

function mockFetch(bodies: Record<string, string>, calls: string[], failPaths: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    if (failPaths.includes(url)) throw new Error('network down')
    const body = bodies[url]
    if (body == null) return new Response('not found', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

beforeEach(async () => {
  await resetDatabase()
})

describe('task-88：私版受限商业词表生成包（VITE_PRIVATE_PACKS）', () => {
  it('清单：公开模式只有大纲；私版模式追加受限商业词表两包', () => {
    const pub = getDefaultContentPacks(false)
    expect(pub.map((entry) => entry.id).sort()).toEqual(DEFAULT_CONTENT_PACKS.map((entry) => entry.id).sort())
    expect(pub.every((entry) => entry.path.startsWith('packs/dagang/'))).toBe(true)
    const priv = getDefaultContentPacks(true)
    expect(priv).toHaveLength(DEFAULT_CONTENT_PACKS.length + PRIVATE_CONTENT_PACKS.length)
    expect(priv.filter((entry) => entry.path.startsWith('packs/hongbaoshu/')).map((entry) => entry.id).sort()).toEqual(
      PRIVATE_CONTENT_PACKS.map((entry) => entry.id).sort(),
    )
    expect(priv.filter((entry) => entry.path.startsWith('packs/hongbaoshu/')).every((entry) => entry.optional)).toBe(true)
    // 非 Vite 测试环境默认关闭
    expect(isPrivatePacksEnabled()).toBe(false)
  })

  it('私版：四包齐全时全部导入；公开模式不会请求受限商业词表路径', async () => {
    await setupDeck()
    const bodies = { ...(await makeBodies()), ...(await makePrivateBodies()) }
    const calls: string[] = []
    const result = await ensureDefaultContentPacks({ includePrivate: true, fetchImpl: mockFetch(bodies, calls) })
    expect(result.ok).toBe(true)
    expect(result.imported).toBe(4)
    expect(result.packs.map((pack) => pack.status)).toEqual(['imported', 'imported', 'imported', 'imported'])
    expect(calls.some((url) => url.includes('/packs/hongbaoshu/'))).toBe(true)

    // 公开模式（新的空 DB）：只请求两个 dagang 包
    await resetDatabase()
    await setupDeck()
    const publicCalls: string[] = []
    const publicResult = await ensureDefaultContentPacks({ includePrivate: false, fetchImpl: mockFetch(bodies, publicCalls) })
    expect(publicResult.ok).toBe(true)
    expect(publicCalls).toHaveLength(DEFAULT_CONTENT_PACKS.length)
    expect(publicCalls.some((url) => url.includes('/packs/hongbaoshu/'))).toBe(false)
  })

  it('私版缺可选文件（examples 未生成）：跳过且不阻塞，仍写版本标记', async () => {
    await setupDeck()
    const bodies = { ...(await makeBodies()), ...(await makePrivateBodies()) }
    const missing = PRIVATE_CONTENT_PACKS.find((entry) => entry.id.includes('examples'))!.path
    delete bodies[`/${missing}`]
    const calls: string[] = []
    const result = await ensureDefaultContentPacks({ includePrivate: true, fetchImpl: mockFetch(bodies, calls) })
    expect(result.ok).toBe(true) // optional missing 不算失败
    expect(result.packs.find((pack) => pack.id.includes('examples'))!.status).toBe('missing')
    expect(result.packs.filter((pack) => pack.status === 'imported')).toHaveLength(3)
    expect(await getDb().meta.get(DEFAULT_PACKS_META_KEY)).toBeDefined() // 不阻塞标记
  })

  it('私版网络失败可选包：记 missing，ok；必选 dagang 失败仍 ok:false 不写标记', async () => {
    await setupDeck()
    const bodies = { ...(await makeBodies()), ...(await makePrivateBodies()) }
    const privatePath = `/${PRIVATE_CONTENT_PACKS[0]!.path}`
    const calls: string[] = []
    const result = await ensureDefaultContentPacks({
      includePrivate: true,
      fetchImpl: mockFetch(bodies, calls, [privatePath]),
    })
    expect(result.ok).toBe(true)
    expect(result.packs.find((pack) => pack.id === PRIVATE_CONTENT_PACKS[0]!.id)!.status).toBe('missing')
    expect(await getDb().meta.get(DEFAULT_PACKS_META_KEY)).toBeDefined()
  })
})

describe('task-87：内置内容包首次启动自动导入', () => {
  it('首次：fetch 两个 pack → import/approve/apply，写版本标记；内容即时生效', async () => {
    const deck = await setupDeck()
    const bodies = await makeBodies()
    const calls: string[] = []
    const result = await ensureDefaultContentPacks({ fetchImpl: mockFetch(bodies, calls) })

    expect(result.ok).toBe(true)
    expect(result.skippedVersion).toBe(false)
    expect(result.imported).toBe(2)
    expect(result.applied).toBe(2)
    expect(result.packs.map((pack) => pack.status)).toEqual(['imported', 'imported'])
    expect(calls).toHaveLength(DEFAULT_CONTENT_PACKS.length)

    const db = getDb()
    const flag = (await db.meta.get(DEFAULT_PACKS_META_KEY))!.value as { version: number }
    expect(flag.version).toBe(DEFAULT_PACKS_VERSION)
    expect((await getPackStats()).packs).toBe(2)
    // 语义生效
    const bank = (await db.words.toArray()).find((word) => word.headwordLower === 'bank')!
    const effective = await getEffectiveContent(bank.id, `${bank.id}#M1`)
    expect(effective!.meaning!.coreSense!.label).toBe('柜台/长凳')
    // 例句/词组生效
    const zebra = (await db.words.toArray()).find((word) => word.headwordLower === 'zebra')!
    expect(zebra.examples.some((example) => example.en.includes('zebra'))).toBe(true)
    expect(zebra.phrases.some((phrase) => phrase.en === 'zebra crossing')).toBe(true)
    expect(zebra.deckId).toBe(deck.id)
  })

  it('幂等：第二次调用读到版本标记 → 不再 fetch', async () => {
    await setupDeck()
    const bodies = await makeBodies()
    const calls: string[] = []
    await ensureDefaultContentPacks({ fetchImpl: mockFetch(bodies, calls) })
    const callsAfterFirst = calls.length
    const second = await ensureDefaultContentPacks({ fetchImpl: mockFetch(bodies, calls) })
    expect(second.ok).toBe(true)
    expect(second.skippedVersion).toBe(true)
    expect(calls.length).toBe(callsAfterFirst) // 未再请求
  })

  it('force：忽略标记重新检查；内容已存在 → skipped（不重复落库）', async () => {
    await setupDeck()
    const bodies = await makeBodies()
    const calls: string[] = []
    await ensureDefaultContentPacks({ fetchImpl: mockFetch(bodies, calls) })
    const db = getDb()
    const before = await db.words.toArray()
    const result = await ensureDefaultContentPacks({ force: true, fetchImpl: mockFetch(bodies, calls) })
    expect(result.ok).toBe(true)
    expect(result.packs.every((pack) => pack.status === 'skipped')).toBe(true)
    expect(calls.length).toBe(DEFAULT_CONTENT_PACKS.length * 2)
    const after = await db.words.toArray()
    const zebraAfter = after.find((word) => word.headwordLower === 'zebra')!
    const zebraBefore = before.find((word) => word.headwordLower === 'zebra')!
    expect(zebraAfter.examples).toHaveLength(zebraBefore.examples.length) // 不重复
  })

  it('文件缺失/网络失败：不阻塞、不写标记；下次重试补齐', async () => {
    await setupDeck()
    const bodies = await makeBodies()
    const paths = DEFAULT_CONTENT_PACKS.map((entry) => `/${entry.path}`)
    const calls: string[] = []
    // 第二次包 404 → 失败；第一个成功
    const partial = await ensureDefaultContentPacks({ fetchImpl: mockFetch({ [paths[0]!]: bodies[paths[0]!]! }, calls) })
    expect(partial.ok).toBe(false)
    expect(partial.packs.map((pack) => pack.status)).toEqual(['imported', 'failed'])
    expect(await getDb().meta.get(DEFAULT_PACKS_META_KEY)).toBeUndefined() // 不写标记，下次重试

    const retry = await ensureDefaultContentPacks({ fetchImpl: mockFetch(bodies, calls) })
    expect(retry.ok).toBe(true)
    expect(retry.packs.map((pack) => pack.status).sort()).toEqual(['imported', 'skipped']) // 第一个已存在跳过
    expect((await getDb().meta.get(DEFAULT_PACKS_META_KEY))!.value).toMatchObject({
      version: DEFAULT_PACKS_VERSION,
    })
  })

  it('网络异常（fetch throw）：返回 ok:false + 警告，不写标记', async () => {
    await setupDeck()
    const bodies = await makeBodies()
    const calls: string[] = []
    const result = await ensureDefaultContentPacks({
      fetchImpl: mockFetch(bodies, calls, DEFAULT_CONTENT_PACKS.map((entry) => `/${entry.path}`)),
    })
    expect(result.ok).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(await getDb().meta.get(DEFAULT_PACKS_META_KEY)).toBeUndefined()
  })

  it('reapplyPack 可修复 skipped(unknown-meaning) 条目（default pack 场景，task-90）', async () => {
    const deck = await setupDeck()
    const bodies = await makeBodies()
    const calls: string[] = []
    const first = await ensureDefaultContentPacks({ fetchImpl: mockFetch(bodies, calls) })
    expect(first.ok).toBe(true)

    const db = getDb()
    const semanticsPack = (await db.packs.toArray()).find((pack) => pack.kind === 'semantics')!
    const items = await db.packItems.where('packId').equals(semanticsPack.id).toArray()
    expect(items.length).toBeGreaterThan(0)
    await db.packItems.update(items[0]!.id, { status: 'skipped', skipReason: 'unknown-meaning' })

    const { reapplyPack } = await import('../../src/data')
    const repaired = await reapplyPack(semanticsPack.id, { deckId: deck.id })
    expect(repaired.retried).toBeGreaterThanOrEqual(1)
    expect(repaired.applied).toBeGreaterThanOrEqual(1)
    expect((await db.packItems.get(items[0]!.id))!.status).toBe('applied')
  })

  it('force 两次：按 checksum 复用已有 pack，不产生重复包', async () => {
    await setupDeck()
    const bodies = await makeBodies()
    const calls: string[] = []
    await ensureDefaultContentPacks({ fetchImpl: mockFetch(bodies, calls) })
    const db = getDb()
    const packsBefore = await db.packs.count()
    const checksumsBefore = (await db.packs.toArray()).map((pack) => pack.checksum)
    expect(new Set(checksumsBefore).size).toBe(packsBefore) // 首次无重复

    const second = await ensureDefaultContentPacks({ force: true, fetchImpl: mockFetch(bodies, calls) })
    expect(second.ok).toBe(true)
    const packsAfter = await db.packs.count()
    expect(packsAfter).toBe(packsBefore) // task-92：不新增重复包
    const checksumsAfter = (await db.packs.toArray()).map((pack) => pack.checksum)
    expect(new Set(checksumsAfter).size).toBe(packsAfter)
    expect(second.packs.every((pack) => pack.status === 'skipped' || pack.status === 'imported')).toBe(true)
  })

  it('checksum 被篡改：该包 failed，不写标记', async () => {
    await setupDeck()
    const bodies = await makeBodies()
    const paths = DEFAULT_CONTENT_PACKS.map((entry) => `/${entry.path}`)
    const tampered = JSON.parse(bodies[paths[0]!]!) as PackFileV1
    tampered.checksum = '0'.repeat(64)
    const calls: string[] = []
    const result = await ensureDefaultContentPacks({
      fetchImpl: mockFetch({ ...bodies, [paths[0]!]: JSON.stringify(tampered) }, calls),
    })
    expect(result.ok).toBe(false)
    expect(result.packs[0]!.status).toBe('failed')
    expect(result.issues.some((issue) => issue.code === 'E_CHECKSUM')).toBe(true)
    expect(await getDb().meta.get(DEFAULT_PACKS_META_KEY)).toBeUndefined()
  })
})
