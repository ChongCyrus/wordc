import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
/**
 * 0.14 B2：AI 内容 apply 写入口统一走 content-write-source。
 * 覆盖 rootMnemonic / nc / senseMnemonic / rootEtymologyBundle / rootEtymology 预装 / rareMark apply：
 * - sqlite 成功 → contentWrite 调用 + IDB cache 同步
 * - sqlite 失败 → 结构化错误/失败返回，且不回写 IDB（cache 保持旧值）
 * - idb 模式 → 不调用 contentWrite，行为与改造前一致
 */

import { afterEach, describe, expect, it } from 'vitest'

import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { RootEtymologyBundle } from '../../src/data/root-etymology-bundle'
import type { PackFileV1, PackItemV1 } from '../../src/data'
import {
  appendAiPack,
  applyApproved,
  applyRareMarkResults,
  applySenseMnemonicSuggestions,
  approveItems,
  clearRootMnemonic,
  clearSenseMnemonic,
  createDeck,
  ensureRootEtymologyPreinstall,
  getDb,
  importPack,
  importRootEtymologyBundle,
  listPackItems,
  mergeDuplicateAiPacks,
  resetDatabase,
  saveRootMnemonic,
  saveSenseMnemonic,
  setNcMeaningIds,
  setSqliteTransport,
  updateSettings,
} from '../../src/data'

afterEach(() => setSqliteTransport(null))

/** 记录 contentWrite 次数；fail=true 时 contentWrite 返回结构化失败 */
function mockSqlite(
  fail = false,
  writeKeys?: string[],
  writeEntries?: Array<{ key: string; json: string }>,
  failKeyPrefix?: string,
) {
  let revision = 0
  let seq = 0
  let writes = 0
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as {
        id: string
        method: string
        payload?: { entries?: Array<{ key?: string; json?: string }> }
      }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, json: string) => void }).__momoSqliteResult
        if (req.method === 'contentCounts') {
          cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision }))
          return
        }
        if (req.method === 'contentWrite') {
          writes += 1
          const entries = req.payload?.entries ?? []
          for (const entry of entries) {
            if (!entry.key) continue
            writeKeys?.push(entry.key)
            writeEntries?.push({ key: entry.key, json: String(entry.json ?? '') })
          }
          const shouldFail = fail || (failKeyPrefix ? entries.some((entry) => entry.key?.startsWith(failKeyPrefix)) : false)
          if (shouldFail) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock fail' }))
            return
          }
          revision += 1
          cb?.(id, JSON.stringify({ ok: true, revision, upserts: 1, tombstones: 0, deletes: 0 }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return () => writes
}

async function makeDeckWord(headword = 'alpha') {
  const deck = await createDeck({
    name: `0.14-ai-${headword}`,
    words: [{ headword, meanings: [{ pos: 'n.', cn: '甲' }, { pos: 'n.', cn: '乙' }] }],
  })
  const db = getDb()
  const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
  return { deck, word, meaningId: word.meanings[0]!.id }
}

async function makePack(
  items: PackItemV1[],
  deckId: string,
  source: 'import' | 'ai' = 'import',
): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'mixed' as const,
    createdAt: Date.UTC(2026, 11, 16),
    generator: 'test@ai-write-source',
    items,
    meta: { source, deckId },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

/** 导入一个带 coreSenses 的语义 pack，让 applySenseMnemonicSuggestions 有可写目标 */
async function setupWithCoreSenses() {
  const deck = await createDeck({
    name: '0.14-ai-sense',
    words: [{ headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }, { pos: 'n.', cn: '阿尔法' }] }],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const file = await makePack(
    [
      {
        headword: 'alpha',
        headwordLower: 'alpha',
        coreSenses: [
          { index: 1, label: '本义一', note: '第一本义', confidence: 'high' },
          { index: 2, label: '本义二', confidence: 'high' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 2 },
        ],
      },
    ],
    deck.id,
  )
  const imported = await importPack(JSON.stringify(file))
  const items = await listPackItems(imported.packId!)
  await approveItems(imported.packId!, items.map((item) => item.id))
  await applyApproved(imported.packId!)
  const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
  return { deck, word }
}

describe('0.14 AI apply 写入口', () => {
  it('rootMnemonic：sqlite 成功→cache 同步；失败→抛错不回写；idb 不调 contentWrite', async () => {
    await resetDatabase()
    const { word } = await makeDeckWord()

    await primeLegacySqliteContentSource()
    const okWrites = mockSqlite(false)
    await saveRootMnemonic(word.id, 'AI 生成元助记', 'ai')
    expect(okWrites()).toBeGreaterThan(0)
    expect((await getDb().words.get(word.id))?.rootMnemonic?.text).toBe('AI 生成元助记')

    mockSqlite(true)
    await expect(saveRootMnemonic(word.id, '失败的助记', 'ai')).rejects.toMatchObject({
      code: 'CONTENT_SQLITE_WRITE_FAILED',
    })
    expect((await getDb().words.get(word.id))?.rootMnemonic?.text).toBe('AI 生成元助记')

    await persistContentWriteSource('idb')
    const idbWrites = mockSqlite(false)
    await saveRootMnemonic(word.id, 'IDB 助记', 'ai')
    expect(idbWrites()).toBe(0)
    expect((await getDb().words.get(word.id))?.rootMnemonic?.text).toBe('IDB 助记')
    await clearRootMnemonic(word.id)
    expect((await getDb().words.get(word.id))?.rootMnemonic).toBeUndefined()
  })

  it('nc：sqlite 成功→cache 同步；失败→抛错不回写；idb 不调 contentWrite', async () => {
    await resetDatabase()
    const { word, meaningId } = await makeDeckWord()

    await primeLegacySqliteContentSource()
    const okWrites = mockSqlite(false)
    expect(await setNcMeaningIds(word.id, [meaningId])).toEqual([meaningId])
    expect(okWrites()).toBeGreaterThan(0)
    expect((await getDb().words.get(word.id))?.ncMeaningIds).toEqual([meaningId])

    mockSqlite(true)
    await expect(setNcMeaningIds(word.id, [])).rejects.toMatchObject({ code: 'CONTENT_SQLITE_WRITE_FAILED' })
    expect((await getDb().words.get(word.id))?.ncMeaningIds).toEqual([meaningId])

    await persistContentWriteSource('idb')
    const idbWrites = mockSqlite(false)
    await setNcMeaningIds(word.id, [])
    expect(idbWrites()).toBe(0)
    expect((await getDb().words.get(word.id))?.ncMeaningIds).toBeUndefined()
  })

  it('senseMnemonic：单条与 AI apply 批量在 sqlite 成功/失败/IDB 下的行为', async () => {
    await resetDatabase()
    const { word } = await setupWithCoreSenses()

    await primeLegacySqliteContentSource()
    const okWrites = mockSqlite(false)
    await saveSenseMnemonic(word.id, { coreSenseIndex: 1, label: '本义一', text: '手动助记', source: 'manual' })
    expect(okWrites()).toBeGreaterThan(0)
    expect((await getDb().words.get(word.id))?.senseMnemonics?.[0]?.text).toBe('手动助记')

    const result = await applySenseMnemonicSuggestions(word.id, [{ coreSenseIndex: 2, label: '本义二', text: 'AI 助记' }], {
      overwriteAi: true,
    })
    expect(result.applied).toBe(1)
    expect((await getDb().words.get(word.id))?.senseMnemonics?.some((entry) => entry.text === 'AI 助记')).toBe(true)

    mockSqlite(true)
    await expect(saveSenseMnemonic(word.id, { coreSenseIndex: 1, label: '本义一', text: '失败助记' })).rejects.toMatchObject({
      code: 'CONTENT_SQLITE_WRITE_FAILED',
    })
    expect((await getDb().words.get(word.id))?.senseMnemonics?.[0]?.text).toBe('手动助记')
    await expect(
      applySenseMnemonicSuggestions(word.id, [{ coreSenseIndex: 2, label: '本义二', text: 'AI 失败' }], { overwriteAi: true }),
    ).rejects.toMatchObject({ code: 'CONTENT_SQLITE_WRITE_FAILED' })
    expect((await getDb().words.get(word.id))?.senseMnemonics?.some((entry) => entry.text === 'AI 失败')).toBe(false)

    await persistContentWriteSource('idb')
    const idbWrites = mockSqlite(false)
    await saveSenseMnemonic(word.id, { coreSenseIndex: 1, label: '本义一', text: 'IDB 助记' })
    expect(idbWrites()).toBe(0)
    expect((await getDb().words.get(word.id))?.senseMnemonics?.[0]?.text).toBe('IDB 助记')
    expect(await clearSenseMnemonic(word.id, { label: '本义一' })).toBe(true)
  })

  it('rootEtymologyBundle 导入：sqlite 成功批量+清空走 cache；失败停止不回写；idb 行为不变', async () => {
    await resetDatabase()
    const deck = await createDeck({
      name: '0.14-bundle',
      words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }],
    })
    const db = getDb()
    const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
    const [alpha, beta] = words as [typeof words[number], typeof words[number]]
    // beta 先有 AI 词源，随后用「无 rootEtymology 的 bundle 条目」验证清空
    await db.words.put({
      ...beta,
      rootEtymology: { parts: [{ type: 'root', text: 'bet', meaning: '字母' }], source: 'ai', updatedAt: 1 },
    } as never)
    const bundle: RootEtymologyBundle = {
      format: 'momo-root-etymology-bundle',
      formatVersion: 1,
      version: '0.3.98',
      createdAt: 1,
      generator: 'test',
      counts: { items: 2 },
      items: [
        { wordId: alpha.id, headword: 'alpha', deckId: deck.id, rootEtymology: { parts: [{ type: 'root', text: 'alph', meaning: '首' }], source: 'ai', updatedAt: 2 } },
        { wordId: beta.id, headword: 'beta', deckId: deck.id },
      ],
    }

    await primeLegacySqliteContentSource()
    const okWrites = mockSqlite(false)
    const report = await importRootEtymologyBundle(bundle, { force: true })
    expect(report.ok).toBe(true)
    expect(report.updated).toBe(2)
    expect(okWrites()).toBeGreaterThan(0)
    expect((await db.words.get(alpha.id))?.rootEtymology?.parts[0]?.text).toBe('alph')
    expect((await db.words.get(beta.id))?.rootEtymology).toBeUndefined()

    // 失败：不改 IDB（alpha 保持上一次成功值；beta 仍无值）
    mockSqlite(true)
    const failReport = await importRootEtymologyBundle(
      { ...bundle, items: [{ wordId: alpha.id, headword: 'alpha', deckId: deck.id, rootEtymology: { parts: [{ type: 'root', text: 'bad', meaning: '坏' }], source: 'ai', updatedAt: 3 } }] },
      { force: true },
    )
    expect(failReport.ok).toBe(false)
    expect(failReport.updated).toBe(0)
    expect(failReport.failed.length).toBeGreaterThan(0)
    expect((await db.words.get(alpha.id))?.rootEtymology?.parts[0]?.text).toBe('alph')

    // idb 模式：不调 contentWrite，行为与改造前一致（含清空）
    await persistContentWriteSource('idb')
    await db.words.put({
      ...(await db.words.get(beta.id))!,
      rootEtymology: { parts: [{ type: 'root', text: 'bet', meaning: '字母' }], source: 'ai', updatedAt: 1 },
    } as never)
    const idbWrites = mockSqlite(false)
    const idbReport = await importRootEtymologyBundle(bundle, { force: true })
    expect(idbReport.ok).toBe(true)
    expect(idbReport.updated).toBe(2)
    expect(idbWrites()).toBe(0)
    expect((await db.words.get(alpha.id))?.rootEtymology?.parts[0]?.text).toBe('alph')
    expect((await db.words.get(beta.id))?.rootEtymology).toBeUndefined()
  })

  it('rootEtymology 预装：sqlite 成功写 cache；失败 meta=failed 不回写；idb 兼容', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: '0.14-preinstall', words: [{ headword: 'gamma', meanings: [{ cn: '丙' }] }] })
    const db = getDb()
    const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    const bundleText = JSON.stringify({
      format: 'momo-root-etymology-bundle',
      formatVersion: 1,
      version: '0.3.98',
      createdAt: 1,
      generator: 'test',
      counts: { items: 1 },
      items: [
        {
          wordId: word.id,
          headword: 'gamma',
          deckId: deck.id,
          rootEtymology: { parts: [{ type: 'root', text: 'gamm', meaning: '丙' }], source: 'ai', updatedAt: 2 },
        },
      ],
    })
    const run = () =>
      ensureRootEtymologyPreinstall({ bundleText, force: true, repairMissingDecks: false, chunkSize: 200 })

    await primeLegacySqliteContentSource()
    const okWrites = mockSqlite(false)
    const okResult = await run()
    expect(okResult.ok).toBe(true)
    expect(okResult.imported).toBe(1)
    expect(okWrites()).toBeGreaterThan(0)
    expect((await db.words.get(word.id))?.rootEtymology?.parts[0]?.text).toBe('gamm')
    expect((await db.meta.get('rootEtymology.preinstall'))?.value).toMatchObject({ state: 'completed' })

    // 失败：清掉词源后重跑，写失败 → meta failed + IDB 无回写
    await db.words.put({ ...(await db.words.get(word.id))!, rootEtymology: undefined } as never)
    mockSqlite(true)
    const failResult = await run()
    expect(failResult.ok).toBe(false)
    expect(failResult.imported).toBe(0)
    expect((await db.words.get(word.id))?.rootEtymology).toBeUndefined()
    expect((await db.meta.get('rootEtymology.preinstall'))?.value).toMatchObject({ state: 'failed' })

    // idb 模式：不调 contentWrite，仍成功写入
    await persistContentWriteSource('idb')
    const idbWrites = mockSqlite(false)
    const idbResult = await run()
    expect(idbResult.ok).toBe(true)
    expect(idbWrites()).toBe(0)
    expect((await db.words.get(word.id))?.rootEtymology?.parts[0]?.text).toBe('gamm')
  })

  it('applyRareMarkResults：sqlite 成功写 cache；失败停止且不回写；idb 行为不变', async () => {
    await resetDatabase()
    const deck = await createDeck({
      name: '0.14-rare',
      words: [{ headword: 'delta', meanings: [{ cn: '丁' }, { cn: '德尔塔' }] }, { headword: 'epsilon', meanings: [{ cn: '戊' }] }],
    })
    const db = getDb()
    const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
    const [delta, epsilon] = words as [typeof words[number], typeof words[number]]

    await primeLegacySqliteContentSource()
    const okWrites = mockSqlite(false)
    const okResult = await applyRareMarkResults([{ wordId: delta.id, rareMeaningIndexes: [1] }], { now: 1, version: 'v' })
    expect(okResult.checked).toBe(1)
    expect(okWrites()).toBeGreaterThan(0)
    expect((await db.words.get(delta.id))?.rareMeaningIds).toEqual([delta.meanings[0]!.id])

    mockSqlite(true)
    const failResult = await applyRareMarkResults(
      [
        { wordId: delta.id, rareMeaningIndexes: [2] },
        { wordId: epsilon.id, rareMeaningIndexes: [1] },
      ],
      { now: 2, version: 'v' },
    )
    expect(failResult.checked).toBe(0)
    expect(failResult.failed).toHaveLength(2)
    expect(failResult.failed[0]?.error).toMatch(/E_IO|mock fail/)
    expect(failResult.failed[1]?.error).toMatch(/已停止/)
    expect((await db.words.get(delta.id))?.rareMeaningIds).toEqual([delta.meanings[0]!.id])
    expect((await db.words.get(epsilon.id))?.rareMeaningIds).toBeUndefined()

    await persistContentWriteSource('idb')
    const idbWrites = mockSqlite(false)
    const idbResult = await applyRareMarkResults(
      [
        { wordId: delta.id, rareMeaningIndexes: [2] },
        { wordId: epsilon.id, rareMeaningIndexes: [1] },
      ],
      { now: 3, version: 'v' },
    )
    expect(idbResult.checked).toBe(2)
    expect(idbWrites()).toBe(0)
    expect((await db.words.get(epsilon.id))?.rareMeaningIds).toEqual([epsilon.meanings[0]!.id])
  })
})

describe('0.14 AI 内容包 apply（ai-packs 合并写入口）', () => {
  /** 两个同 deck 的 AI 内容包（同一 headword，不同例句），用于 mergeDuplicateAiPacks 合并路径 */
  async function setupTwoAiPacks() {
    const deck = await createDeck({
      name: `0.14-ai-packs-${Date.now()}`,
      words: [{ headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }] }],
    })
    const first = await importPack(
      JSON.stringify(
        await makePack(
          [{ headword: 'alpha', headwordLower: 'alpha', meaningIndex: 1, examples: [{ en: 'A one', cn: '一' }] }],
          deck.id,
          'ai',
        ),
      ),
    )
    const second = await importPack(
      JSON.stringify(
        await makePack(
          [{ headword: 'alpha', headwordLower: 'alpha', meaningIndex: 1, examples: [{ en: 'A two', cn: '二' }] }],
          deck.id,
          'ai',
        ),
      ),
    )
    return { deck, packIds: [first.packId!, second.packId!] }
  }

  it('sqlite 成功→contentWrite + IDB cache 合并；失败→结构化错误且不回写 IDB；idb 不调 contentWrite', async () => {
    // 1) sqlite 成功
    await resetDatabase()
    await setupTwoAiPacks() // 先按 idb 建包（source 切换前）
    await primeLegacySqliteContentSource()
    const db = getDb()
    const writtenKeys: string[] = []
    const okWrites = mockSqlite(false, writtenKeys)
    const merged = await mergeDuplicateAiPacks()
    expect(merged.groups).toBe(1)
    expect(merged.removed).toBe(1)
    expect(merged.kept).toHaveLength(1)
    expect(okWrites()).toBeGreaterThan(0)
    // pack-item 内容行确实走了统一写入口（key 规范 pack-item:<id>）
    expect(writtenKeys.some((key) => key.startsWith(`pack-item:${merged.kept[0]}`))).toBe(true)
    const keeperItems = await db.packItems.where('packId').equals(merged.kept[0]!).toArray()
    expect(keeperItems).toHaveLength(1)
    expect((keeperItems[0]!.payload.examples ?? []).map((entry) => entry.en)).toEqual(
      expect.arrayContaining(['A one', 'A two']),
    )

    // 2) sqlite 失败：merge 抛结构化错误，IDB 两条原 item 均未被改写
    await resetDatabase()
    await setupTwoAiPacks()
    await primeLegacySqliteContentSource()
    mockSqlite(true)
    await expect(mergeDuplicateAiPacks()).rejects.toMatchObject({ code: 'CONTENT_SQLITE_WRITE_FAILED' })
    const untouched = await getDb().packItems.toArray()
    expect(untouched).toHaveLength(2)
    expect(untouched.every((record) => (record.payload.examples ?? []).length === 1)).toBe(true)

    // 3) idb 模式：不调 contentWrite，合并行为与改造前一致
    await resetDatabase()
    await setupTwoAiPacks()
    await persistContentWriteSource('idb')
    const idbWrites = mockSqlite(false)
    const idbMerged = await mergeDuplicateAiPacks()
    expect(idbMerged.removed).toBe(1)
    expect(idbWrites()).toBe(0)
    const idbItems = await getDb().packItems.where('packId').equals(idbMerged.kept[0]!).toArray()
    expect(idbItems).toHaveLength(1)
    expect((idbItems[0]!.payload.examples ?? []).map((entry) => entry.en)).toEqual(
      expect.arrayContaining(['A one', 'A two']),
    )
  })

  it('合并后 pack 记录（counts/checksum）走 pack:<id> 写源；pack 写失败不回写 IDB；idb 原样', async () => {
    // 1) sqlite 成功：content_kv 的 pack 行 counts/checksum 已更新，IDB cache 与其一致
    await resetDatabase()
    await setupTwoAiPacks()
    await primeLegacySqliteContentSource()
    const db = getDb()
    const before = new Map((await db.packs.toArray()).map((pack) => [pack.id, { checksum: pack.checksum, counts: pack.counts }]))
    const entries: Array<{ key: string; json: string }> = []
    const okWrites = mockSqlite(false, undefined, entries)
    const merged = await mergeDuplicateAiPacks()
    expect(okWrites()).toBeGreaterThan(0)
    const keeper = merged.kept[0]!
    const packRows = entries.filter((entry) => entry.key === `pack:${keeper}`)
    expect(packRows.length).toBeGreaterThan(0)
    const latestRow = JSON.parse(packRows[packRows.length - 1]!.json) as { checksum: string; counts: { items: number } }
    expect(latestRow.counts.items).toBe(1)
    expect(latestRow.checksum).not.toBe(before.get(keeper)!.checksum)
    const cached = await db.packs.get(keeper)
    expect(cached?.counts.items).toBe(1)
    expect(cached?.checksum).toBe(latestRow.checksum)

    // 2) sqlite pack 行写失败：抛结构化错误，IDB pack 记录保持旧值（packItems 行已写成功也不会回写 pack）
    await resetDatabase()
    await setupTwoAiPacks()
    await primeLegacySqliteContentSource()
    const db2 = getDb()
    const before2 = new Map((await db2.packs.toArray()).map((pack) => [pack.id, { checksum: pack.checksum, items: pack.counts.items }]))
    mockSqlite(false, undefined, undefined, 'pack:')
    await expect(mergeDuplicateAiPacks()).rejects.toMatchObject({ code: 'CONTENT_SQLITE_WRITE_FAILED' })
    for (const pack of await db2.packs.toArray()) {
      expect(pack.checksum).toBe(before2.get(pack.id)!.checksum)
      expect(pack.counts.items).toBe(before2.get(pack.id)!.items)
    }

    // 3) idb 模式：不调 contentWrite，pack 记录照旧更新
    await resetDatabase()
    await setupTwoAiPacks()
    await persistContentWriteSource('idb')
    const idbEntries: Array<{ key: string; json: string }> = []
    const idbWrites = mockSqlite(false, undefined, idbEntries)
    const idbMerged = await mergeDuplicateAiPacks()
    expect(idbWrites()).toBe(0)
    expect(idbEntries).toHaveLength(0)
    const idbPack = await getDb().packs.get(idbMerged.kept[0]!)
    expect(idbPack?.counts.items).toBe(1)
  })

  it('appendAiPack 补 name：sqlite 先写 pack 行再更新 IDB cache；idb 不调 contentWrite', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: '0.14-ai-name', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const file1 = await makePack(
      [{ headword: 'alpha', headwordLower: 'alpha', meaningIndex: 1, examples: [{ en: 'named', cn: '命名' }] }],
      deck.id,
      'ai',
    )
    file1.meta = { ...file1.meta, name: '' } // import 后 name 为空才会走 appendAiPack 的补 name 分支
    const packJson = JSON.stringify(file1)

    await primeLegacySqliteContentSource()
    const entries: Array<{ key: string; json: string }> = []
    const sqliteWrites = mockSqlite(false, undefined, entries)
    const result = await appendAiPack(packJson, { name: 'AI 批次名' })
    expect(sqliteWrites()).toBeGreaterThan(0)
    const namedRow = entries
      .filter((entry) => entry.key === `pack:${result.packId}`)
      .map((entry) => JSON.parse(entry.json) as { name?: string })
      .find((row) => row.name === 'AI 批次名')
    expect(namedRow).toBeTruthy()
    expect((await getDb().packs.get(result.packId))?.name).toBe('AI 批次名')

    await resetDatabase()
    const deck2 = await createDeck({ name: '0.14-ai-name-idb', words: [{ headword: 'beta', meanings: [{ cn: '乙' }] }] })
    const file2 = await makePack(
      [{ headword: 'beta', headwordLower: 'beta', meaningIndex: 1, examples: [{ en: 'named idb', cn: '命名' }] }],
      deck2.id,
      'ai',
    )
    file2.meta = { ...file2.meta, name: '' }
    const packJson2 = JSON.stringify(file2)
    await persistContentWriteSource('idb')
    const idbEntries: Array<{ key: string; json: string }> = []
    const idbWrites = mockSqlite(false, undefined, idbEntries)
    const idbResult = await appendAiPack(packJson2, { name: 'IDB 批次名' })
    expect(idbWrites()).toBe(0)
    expect(idbEntries).toHaveLength(0)
    expect((await getDb().packs.get(idbResult.packId))?.name).toBe('IDB 批次名')
  })
})
