/** 0.3.91/task-270：私版预生成数据首次导入（幂等/merge 手改/失败重试/公开跳过） */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GENERATED_META_KEY,
  buildInitialState,
  createDeck,
  ensureDefaultGeneratedData,
  getDb,
  getWord,
  resetDatabase,
  saveSenseMnemonic,
  updateSettings,
} from '../../src/data'

const SENSE_FILE = {
  format: 'wordc-core-sense-mnemonics',
  version: 1,
  exportedAt: 1,
  words: [{ wordId: '', deckId: '', headword: 'beta', overview: { text: '预装串联' } }],
  senses: [] as Array<Record<string, unknown>>,
}
const BUNDLE = {
  format: 'wordc-derivation-bundle',
  formatVersion: 1,
  exportedAt: 1,
  items: [] as Array<Record<string, unknown>>,
}

function fakeFetch(files: Record<string, string>, failUrls: Set<string> = new Set()) {
  return (async (url: string) => {
    if (failUrls.has(url)) return { ok: false, status: 500, text: async () => '' }
    const text = files[url]
    if (text == null) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => text }
  }) as unknown as typeof fetch
}

async function setupWords() {
  const deck = await createDeck({
    name: 'generated',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲' }] },
      { headword: 'beta', meanings: [{ cn: '乙' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  const alpha = words.find((word) => word.headword === 'alpha')!
  const beta = words.find((word) => word.headword === 'beta')!
  const now = Date.now()
  for (const [packId, word] of [['generated-alpha', alpha], ['generated-beta', beta]] as const) {
    await db.packItems.put({
      id: `${packId}:1`,
      packId,
      seq: 1,
      wordId: word.id,
      headword: word.headword,
      headwordLower: word.headwordLower,
      payload: { headword: word.headword, coreSenses: [{ index: 1, label: '本义' }] },
      status: 'applied',
      contentHashes: [],
      createdAt: now,
      appliedAt: now,
    })
  }
  return { deck, alpha, beta }
}

describe('0.3.91 · default generated data', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('公开版跳过：不 fetch、不写 meta', async () => {
    const result = await ensureDefaultGeneratedData({ includePrivate: false })
    expect(result.skippedPublic).toBe(true)
    expect(await getDb().meta.get(DEFAULT_GENERATED_META_KEY)).toBeUndefined()
  })

  it('导入本义助记/overview/引申图；幂等；manual 不被覆盖', async () => {
    const { alpha, beta } = await setupWords()
    const db = getDb()
    await db.words.update(alpha.id, {
      derivationMap: { rootLabel: '手改根', text: '手改', source: 'manual', updatedAt: Date.now() },
    })
    await saveSenseMnemonic(alpha.id, { coreSenseIndex: 1, label: '本义', text: '手改助记' })
    const sense = JSON.parse(JSON.stringify(SENSE_FILE))
    sense.words = [{ wordId: beta.id, deckId: beta.deckId, headword: beta.headword, overview: { text: '预装串联' } }]
    sense.senses = [
      { wordId: alpha.id, headword: alpha.headword, coreSenseIndex: 1, label: '本义', mnemonic: { text: '预装助记 alpha' } },
      { wordId: beta.id, headword: beta.headword, coreSenseIndex: 1, label: '本义', mnemonic: { text: '预装助记 beta' } },
    ]
    const bundle = JSON.parse(JSON.stringify(BUNDLE))
    bundle.items = [
      { wordId: alpha.id, headword: alpha.headword, deckId: alpha.deckId, rootLabel: '预装根 alpha', source: 'ai' },
      { wordId: beta.id, headword: beta.headword, deckId: beta.deckId, rootLabel: '预装根 beta', source: 'ai' },
    ]
    const files = {
      '/generated/core-sense-mnemonics.json': JSON.stringify(sense),
      '/generated/dagang-derivation-bundle-v1.json': JSON.stringify(bundle),
    }
    const progress: string[] = []
    const result = await ensureDefaultGeneratedData({
      includePrivate: true,
      nativeOnly: false,
      baseUrl: '/',
      fetchImpl: fakeFetch(files),
      onProgress: (p) => progress.push(p.phase),
    })
    expect(result.ok).toBe(true)
    expect(progress).toContain('sense')
    expect(result.skippedVersion).toBe(false)
    expect((await getWord(alpha.id))!.derivationMap?.rootLabel).toBe('手改根') // manual 不被覆盖
    expect((await getWord(alpha.id))!.senseMnemonics?.[0]?.text).toBe('手改助记')
    expect((await getWord(beta.id))!.derivationMap?.rootLabel).toBe('预装根 beta')
    expect((await getWord(beta.id))!.senseMnemonics?.[0]?.text).toBe('预装助记 beta')
    expect((await getWord(beta.id))!.coreSenseOverview?.text).toBe('预装串联')
    expect((await db.meta.get(DEFAULT_GENERATED_META_KEY))?.value).toMatchObject({ version: 1 })

    // 幂等：第二次 skippedVersion
    const again = await ensureDefaultGeneratedData({ includePrivate: true, nativeOnly: false, baseUrl: '/', fetchImpl: fakeFetch(files) })
    expect(again.skippedVersion).toBe(true)
  }, 20_000)

  it('非 APK/Web 默认跳过，不 fetch', async () => {
    const result = await ensureDefaultGeneratedData({ includePrivate: true })
    expect(result.skippedNonNative).toBe(true)
    expect(await getDb().meta.get(DEFAULT_GENERATED_META_KEY)).toBeUndefined()
  })

  it('已有生成数据超过阈值 → 直接写 meta 跳过，不 fetch', async () => {
    const { alpha } = await setupWords()
    await getDb().words.update(alpha.id, { derivationMap: { rootLabel: '已有', source: 'ai', updatedAt: Date.now() } })
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return { ok: false, status: 500, text: async () => '' }
    }) as unknown as typeof fetch
    const result = await ensureDefaultGeneratedData({
      includePrivate: true,
      nativeOnly: false,
      existingThreshold: 1,
      fetchImpl,
    })
    expect(result.skippedExisting).toBe(true)
    expect(called).toBe(0)
    expect((await getDb().meta.get(DEFAULT_GENERATED_META_KEY))?.value).toMatchObject({ version: 1 })
  })

  it('autoMode：已有 state（老用户）直接跳过，不 fetch', async () => {
    const { alpha } = await setupWords()
    const state = buildInitialState(alpha, Date.now())
    await getDb().states.put({ ...state, phase: 'learning' })
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return { ok: false, status: 500, text: async () => '' }
    }) as unknown as typeof fetch
    const result = await ensureDefaultGeneratedData({
      includePrivate: true,
      nativeOnly: false,
      autoMode: true,
      fetchImpl,
    })
    expect(result.skippedExisting).toBe(true)
    expect(called).toBe(0)
    expect((await getDb().meta.get(DEFAULT_GENERATED_META_KEY))?.value).toBeUndefined()
  })

  it('0.3.95 fresh：内容包未 apply 时本义全 stale → 不标记完成；补包后重试成功', async () => {
    const { alpha, beta } = await setupWords()
    const db = getDb()
    const packRows = await db.packItems.toArray()
    await db.packItems.clear() // 模拟手动「立即导入」早于内容包 apply
    const sense = JSON.parse(JSON.stringify(SENSE_FILE))
    sense.words = [{ wordId: beta.id, deckId: beta.deckId, headword: beta.headword, overview: { text: '预装串联' } }]
    sense.senses = [
      { wordId: alpha.id, headword: alpha.headword, coreSenseIndex: 1, label: '本义', mnemonic: { text: '预装助记 alpha' } },
      { wordId: beta.id, headword: beta.headword, coreSenseIndex: 1, label: '本义', mnemonic: { text: '预装助记 beta' } },
    ]
    const files = {
      '/generated/core-sense-mnemonics.json': JSON.stringify(sense),
      '/generated/dagang-derivation-bundle-v1.json': JSON.stringify(BUNDLE),
    }
    const first = await ensureDefaultGeneratedData({
      includePrivate: true,
      nativeOnly: false,
      baseUrl: '/',
      fetchImpl: fakeFetch(files),
    })
    expect(first.ok).toBe(false)
    expect(first.senseReport?.counts.sensesImported).toBe(0)
    expect((await db.meta.get(DEFAULT_GENERATED_META_KEY))?.value).toBeUndefined()
    // 内容包 apply 后重试
    await db.packItems.bulkPut(packRows)
    const second = await ensureDefaultGeneratedData({
      includePrivate: true,
      nativeOnly: false,
      baseUrl: '/',
      fetchImpl: fakeFetch(files),
    })
    expect(second.ok).toBe(true)
    expect(second.senseReport?.counts.sensesImported).toBeGreaterThan(0)
    expect((await getWord(alpha.id))?.senseMnemonics?.length).toBeGreaterThan(0)
  })

  it('失败不写 meta，下次启动重试', async () => {
    const { beta } = await setupWords()
    const files = {
      '/generated/core-sense-mnemonics.json': JSON.stringify(SENSE_FILE),
      '/generated/dagang-derivation-bundle-v1.json': JSON.stringify(BUNDLE),
    }
    const first = await ensureDefaultGeneratedData({
      includePrivate: true,
      nativeOnly: false,
      baseUrl: '/',
      fetchImpl: fakeFetch(files, new Set(['/generated/core-sense-mnemonics.json'])),
    })
    expect(first.ok).toBe(false)
    expect((await getDb().meta.get(DEFAULT_GENERATED_META_KEY))?.value).toBeUndefined()
    expect(await getWord(beta.id)).toBeTruthy()

    const second = await ensureDefaultGeneratedData({ includePrivate: true, nativeOnly: false, baseUrl: '/', fetchImpl: fakeFetch(files) })
    expect(second.ok).toBe(true)
    expect((await getDb().meta.get(DEFAULT_GENERATED_META_KEY))?.value).toMatchObject({ version: 1 })
  })
})
