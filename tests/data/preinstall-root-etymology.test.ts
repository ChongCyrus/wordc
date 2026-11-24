/** 0.7.0：rootEtymology 预装导入（fresh/重复/手改保护/坏包/缺词/分片合并） */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ROOT_ETYMOLOGY_BUNDLE_FORMAT,
  ROOT_ETYMOLOGY_BUNDLE_VERSION,
  createDeck,
  ensureRootEtymologyPreinstall,
  getDb,
  getRootEtymology,
  getRootEtymologyPreinstallStatus,
  mergeRootEtymologyBundles,
  resetDatabase,
  saveRootEtymology,
  updateSettings,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({ name: 'preinstall-root', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const words = (await getDb().words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
  return { deck, words }
}

function bundleFor(items: Array<{ wordId: string; headword: string; deckId: string }>) {
  return JSON.stringify({
    format: ROOT_ETYMOLOGY_BUNDLE_FORMAT,
    formatVersion: ROOT_ETYMOLOGY_BUNDLE_VERSION,
    version: '0.7.0',
    createdAt: 1,
    generator: 'test',
    counts: { items: items.length },
    items: items.map((item) => ({
      ...item,
      rootEtymology: { parts: [{ type: 'root', text: 'alph', meaning: '首' }], etymology: 'a', source: 'ai', updatedAt: 1 },
    })),
  })
}

describe('0.7.0 · root etymology preinstall', () => {
  beforeEach(async () => { await resetDatabase() })

  it('fresh 导入/重复跳过/手改保护/缺词 stale', async () => {
    const { words } = await setup()
    await saveRootEtymology(words[1]!.id, { parts: [{ type: 'root', text: 'manual', meaning: '手改' }] }, { source: 'manual' })
    const text = bundleFor([
      { wordId: words[0]!.id, headword: 'alpha', deckId: words[0]!.deckId },
      { wordId: words[1]!.id, headword: 'beta', deckId: words[1]!.deckId },
      { wordId: 'missing', headword: 'missing', deckId: words[0]!.deckId },
    ])
    const first = await ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false })
    expect(first.ok).toBe(true)
    expect(first.imported).toBe(1) // beta 已有手改，不覆盖
    expect(first.stale).toBe(1) // missing
    expect((await getRootEtymology(words[0]!.id))?.parts[0]?.text).toBe('alph')
    expect((await getRootEtymology(words[1]!.id))?.parts[0]?.text).toBe('manual')
    const meta = await getRootEtymologyPreinstallStatus()
    expect(meta).toMatchObject({ state: 'completed', count: 2, total: 3, version: '0.7.0' })
    expect(meta?.debug).toMatchObject({ bundleIds: 3, dbFound: 2, rootless: 1, missing: 1, imported: 1, conflicts: 1, stale: 1 })
    const clean = bundleFor([
      { wordId: words[0]!.id, headword: 'alpha', deckId: words[0]!.deckId },
      { wordId: words[1]!.id, headword: 'beta', deckId: words[1]!.deckId },
    ])
    const second = await ensureRootEtymologyPreinstall({ bundleText: clean, repairMissingDecks: false })
    expect(second.skippedVersion).toBe(true)
    expect(second.imported).toBe(0)
  })

  it('0.7.4 并发单飞：两次并发只一次导入、meta 不被覆盖 count0；二次启动 skip', async () => {
    const { words } = await setup()
    const text = bundleFor([
      { wordId: words[0]!.id, headword: 'alpha', deckId: words[0]!.deckId },
      { wordId: words[1]!.id, headword: 'beta', deckId: words[1]!.deckId },
    ])
    const [first, second] = await Promise.all([
      ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false }),
      ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false }),
    ])
    expect(first).toBe(second) // 同一 in-flight promise/result
    expect(first.imported).toBe(2)
    expect((await getRootEtymologyPreinstallStatus())?.count).toBe(2)
    const again = await ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false })
    expect(again.skippedVersion).toBe(true)
    expect(again.imported).toBe(0)
    expect((await getRootEtymologyPreinstallStatus())?.count).toBe(2)

  })

  it('0.7.2 DB 缺词 → repairDecks 重种后导入 2/2 stale0', async () => {
    const { words } = await setup()
    const db = getDb()
    const beta = words[1]!
    await db.words.delete(beta.id)
    let repairs = 0
    const result = await ensureRootEtymologyPreinstall({
      bundleText: bundleFor([
        { wordId: words[0]!.id, headword: 'alpha', deckId: words[0]!.deckId },
        { wordId: beta.id, headword: beta.headword, deckId: beta.deckId },
      ]),
      repairDecks: async () => {
        repairs += 1
        await db.words.put(beta)
      },
      force: true,
    })
    expect(repairs).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.imported).toBe(2)
    expect(result.stale).toBe(0)
    expect((await getRootEtymology(beta.id))?.parts[0]?.text).toBe('alph')
  })

  it('0.7.4 Web 部分词表：已有 AI root + 缺词时 count 不为 0', async () => {
    const { words } = await setup()
    // 模拟 6668/5528：DB 只有前两词且已有 AI root
    await saveRootEtymology(words[0]!.id, { parts: [{ type: 'root', text: 'a', meaning: '甲' }] }, { source: 'ai' })
    await saveRootEtymology(words[1]!.id, { parts: [{ type: 'root', text: 'b', meaning: '乙' }] }, { source: 'ai' })
    const text = bundleFor([
      { wordId: words[0]!.id, headword: words[0]!.headword, deckId: words[0]!.deckId },
      { wordId: words[1]!.id, headword: words[1]!.headword, deckId: words[1]!.deckId },
      { wordId: 'missing-deck-word', headword: 'missing', deckId: words[0]!.deckId },
    ])
    const first = await ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false })
    expect(first.imported).toBe(0)
    expect((await getRootEtymologyPreinstallStatus())?.count).toBe(2)
    const second = await ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false })
    expect(second.imported).toBe(0)
    expect((await getRootEtymologyPreinstallStatus())?.count).toBe(2) // 不归 0
  })

  it('0.10.0 已完成且 count=total：二次启动 meta fast skip，不重复写', async () => {
    const { words } = await setup()
    const text = bundleFor([
      { wordId: words[0]!.id, headword: 'alpha', deckId: words[0]!.deckId },
      { wordId: words[1]!.id, headword: 'beta', deckId: words[1]!.deckId },
    ])
    const first = await ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false })
    expect(first.imported).toBe(2)
    const db = getDb()
    const before = await db.words.toArray()
    const second = await ensureRootEtymologyPreinstall({ bundleText: text, repairMissingDecks: false })
    expect(second.skippedVersion).toBe(true)
    expect(second.imported).toBe(0)
    expect(await db.words.toArray()).toEqual(before)
  })

  it('坏包/缺字段失败不标 completed；可重试', async () => {
    await setup()
    const bad = await ensureRootEtymologyPreinstall({ bundleText: JSON.stringify({ format: 'wrong' }) })
    expect(bad.ok).toBe(false)
    const status = await getRootEtymologyPreinstallStatus()
    expect(status?.state).toBe('failed')
    expect(status?.error).toBeTruthy()
  })

  it('500 分片合并按 wordId 去重、parts.meaning 必填、checksum 统计', async () => {
    const { words } = await setup()
    const part1 = JSON.parse(bundleFor([{ wordId: words[0]!.id, headword: 'alpha', deckId: words[0]!.deckId }]))
    const part2 = JSON.parse(bundleFor([
      { wordId: words[0]!.id, headword: 'alpha', deckId: words[0]!.deckId }, // dup
      { wordId: words[1]!.id, headword: 'beta', deckId: words[1]!.deckId },
    ]))
    part2.items[1].rootEtymology.parts[0].meaning = ''
    const merged = await mergeRootEtymologyBundles([part1, part2])
    expect(merged.stats.duplicate).toBeGreaterThanOrEqual(1)
    expect(merged.stats.stale).toBeGreaterThanOrEqual(1)
    expect(merged.bundle?.counts.items).toBe(2)
    expect(merged.bundle?.checksum).toBeTruthy()
  })
})
