/** 0.7.0：真实 4.5MB rootEtymology bundle 预装耗时/分块进度/重复跳过 */
import './test-utils'
// @ts-ignore node types not installed in app tsconfig
import { existsSync, readFileSync } from 'node:fs'
// @ts-ignore
import { resolve } from 'node:path'
declare const process: { cwd(): string }
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildInitialState,
  ensureBuiltinDecks,
  ensureRootEtymologyPreinstall,
  getDb,
  getRootEtymologyPreinstallStatus,
  resetDatabase,
} from '../../src/data'

const BUNDLE = resolve(process.cwd(), 'data/generated/root-etymology.bundle.json')
// 公开树不含 data/generated（私版预装资产），无 bundle 时跳过真实数据测试
const describeReal = existsSync(BUNDLE) ? describe : describe.skip

describeReal('0.7.0 · real rootEtymology bundle', () => {
  beforeEach(async () => { await resetDatabase() })

  it('0.7.3 已有 states + 缺 34 词：增量补词后 states 保留、imported 5528/stale0', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const text = readFileSync(BUNDLE, 'utf8')
    const parsed = JSON.parse(text) as { items: Array<{ wordId: string }> }
    const hongId = parsed.items[0]!.wordId.split(':')[0]!
    const words = await db.words.where('deckId').equals(hongId).limit(3).toArray()
    for (const word of words) await db.states.put({ ...buildInitialState(word, Date.now()), phase: 'review' })
    // 删除 34 个真实存在的词行，模拟旧版 6668 词表；repair 时把 bundle 全部缺失词补成最小词行
    const hongWords = await db.words.where('deckId').equals(hongId).limit(34).toArray()
    for (const word of hongWords) await db.words.delete(word.id)
    expect(await db.states.count()).toBe(3)
    const result = await ensureRootEtymologyPreinstall({
      bundleText: text,
      chunkSize: 200,
      repairDecks: async () => {
        const now = Date.now()
        const minimal = parsed.items.map((item, index) => ({
          id: item.wordId,
          deckId: hongId,
          headword: (item as unknown as { headword?: string }).headword ?? item.wordId.split(':')[1] ?? item.wordId,
          headwordLower: ((item as unknown as { headword?: string }).headword ?? item.wordId.split(':')[1] ?? item.wordId).toLowerCase(),
          meanings: [{ id: `${item.wordId}#M1`, cn: '测试', pos: 'n.' }],
          examples: [],
          mnemonics: [],
          phrases: [],
          order: index,
          createdAt: now,
        }))
        await db.words.bulkPut(minimal as never)
      },
    })
    expect(result.imported).toBe(5528)
    expect(result.stale).toBe(0)
    expect(await db.states.count()).toBe(3)
    expect((await db.states.get(words[0]!.id))?.phase).toBe('review')
  }, 120_000)

  it('真实 5528 条：分块写入/进度/重复启动跳过', async () => {
    await ensureBuiltinDecks()
    const text = readFileSync(BUNDLE, 'utf8')
    const phases: string[] = []
    let last = { done: 0, total: 0 }
    const t0 = Date.now()
    const first = await ensureRootEtymologyPreinstall({
      bundleText: text,
      chunkSize: 200,
      repairDecks: async () => {
        const db = getDb()
        const parsed = JSON.parse(text) as { items: Array<{ wordId: string; headword?: string }> }
        const deckId = parsed.items[0]!.wordId.split(':')[0]!
        const existing = new Set((await db.words.where('deckId').equals(deckId).primaryKeys()) as string[])
        const now = Date.now()
        const missing = parsed.items
          .filter((item) => !existing.has(item.wordId))
          .map((item, index) => ({
            id: item.wordId,
            deckId,
            headword: item.headword ?? item.wordId.split(':')[1] ?? item.wordId,
            headwordLower: (item.headword ?? item.wordId.split(':')[1] ?? item.wordId).toLowerCase(),
            meanings: [{ id: `${item.wordId}#M1`, cn: '测试', pos: 'n.' }],
            examples: [], mnemonics: [], phrases: [], order: index, createdAt: now,
          }))
        await db.words.bulkPut(missing as never)
      },
      onProgress: (progress) => {
        phases.push(progress.phase)
        last = { done: progress.done, total: progress.total }
      },
    })
    const elapsedMs = Date.now() - t0
    const dbCount = await getDb().words.count()
    if (!first.ok) console.log('REAL_ISSUES', JSON.stringify(first.issues))
    console.log('REAL_ROOT_PREINSTALL', { elapsedMs, dbCount, imported: first.imported, total: first.total, stale: first.stale, phases: [...new Set(phases)], last })
    expect(first.ok).toBe(true)
    expect(first.imported).toBeGreaterThan(6500)
    expect(first.total).toBe(5528)
    expect(first.stale).toBeLessThanOrEqual(50)
    expect(phases).toContain('parse')
    expect(phases).toContain('write')
    expect(phases).toContain('done')
    expect(last).toEqual({ done: 5528, total: 5528 })
    const db = getDb()
    const withRoot = await db.words.filter((word) => Boolean(word.rootEtymology)).count()
    expect(withRoot).toBe(first.imported)
    const meta = await getRootEtymologyPreinstallStatus()
    expect(meta).toMatchObject({ state: 'completed', count: first.imported, total: 5528, version: '0.7.0' })
    // 重复启动：同版本 completed 直接跳过，不写
    const second = await ensureRootEtymologyPreinstall({ bundleText: text, chunkSize: 200, repairMissingDecks: false })
    // 测试 fixture 仍缺 34 个 deck 词，因此不会进入 skip；但重复调用不得重复写
    expect(second.imported).toBe(0)
  }, 120_000)
})
