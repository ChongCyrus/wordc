/** 0.6.2 P1：多类型 runner 必须处理全部 34 targets，不能第一类型后 completed */
import './test-utils'
import { describe, expect, it } from 'vitest'
import {
  buildMultiKindGenerationTargets,
  createDeck,
  createGenerationJob,
  getDb,
  getGenerationJob,
  getGenerationJobProgress,
  resetDatabase,
  runGenerationJob,
  updateSettings,
} from '../../src/data'

const config = { provider: 'deepseek', baseUrl: 'https://example.invalid', model: 'deepseek-chat', apiKey: 'k', maxCostPerRun: 0 } as never

const COUNTS: Record<string, number> = {
  examples: 4, phrases: 4, mnemonics: 4, semantics: 4, 'core-sense': 4,
  overview: 4, 'meaning-mnemonic': 4, 'root-etymology': 3, derivation: 2, 'rare-meanings': 1,
}
function targetsFor(kind: string, count: number, offset: number) {
  return Array.from({ length: count }, (_, i) => {
    const wordId = `w${offset + i}`
    const context = {
      meanings: [{ id: `${wordId}-m1`, cn: '义1' }, { id: `${wordId}-m2`, cn: '义2' }],
      coreSenses: [{ index: 1, label: '本义' }],
      ...(kind === 'meaning-mnemonic' ? { meaningIndex: 1 } : {}),
      ...(kind === 'core-sense' ? { coreSenseIndex: 1, coreSenseLabel: '本义' } : {}),
    }
    return { wordId, headword: `word${offset + i}`, kind, context }
  })
}

function providerForAll() {
  return {
    id: 'deepseek' as const,
    async chat(body: { messages: Array<{ content: string }> }) {
      const system = body.messages[0]?.content ?? ''
      const kind =
        system.match(/本次类型：([^。]+)/)?.[1] ??
        (system.includes('rareMeaningIndexes') ? 'rare-meanings' : system.includes('rootLabel') ? 'derivation' : 'examples')
      const user = body.messages[1]?.content ?? ''
      const rows = JSON.parse(user.slice(user.indexOf('['))) as Array<{ wordId: string; targetKey?: string }>
      const payloadFor = (wordId: string) => {
        switch (kind) {
          case 'examples': return { wordId, examples: [{ en: `${wordId} en`, cn: '例' }] }
          case 'phrases': return { wordId, phrases: [{ en: `${wordId} phrase`, cn: '组' }] }
          case 'mnemonics': case 'meaning-mnemonic': return { wordId, mnemonics: [{ type: 'assoc', text: '联想' }] }
          case 'root-etymology': return { wordId, parts: [{ type: 'root', text: 'root', meaning: '义' }] }
          case 'derivation': return { wordId, rootLabel: 'gen', text: '引申' }
          case 'rare-meanings': return { wordId, rareMeaningIndexes: [1], rareCoreSenseIndexes: [1] }
          case 'semantics': return { wordId, coreSenses: [{ index: 1, label: '本义', confidence: 'high' }], meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }, { meaningIndex: 2, coreSenseIndex: 1 }] }
          case 'core-sense': return { wordId, examples: [{ en: 'x', cn: '例' }] }
          case 'overview': return { wordId, text: '本义串联' }
          default: return { wordId, examples: [{ en: 'x', cn: '例' }] }
        }
      }
      return {
        text: JSON.stringify({ items: rows.map((row) => ({ ...(payloadFor(row.wordId) as object), targetKey: row.targetKey, wordId: row.wordId })) }),
        usage: { input: 1, output: 1, total: 2 },
      }
    },
  } as never
}

describe('0.6.2 · multi-kind runner', () => {
  it('0.6.3 QA seed：2 词 + coreSenses → 10 类型合计 34 targets', async () => {
    await resetDatabase()
    const deck = await createDeck({
      name: 'qa-34',
      words: [
        { headword: 'alpha', meanings: [{cn:'甲1'},{cn:'甲2'},{cn:'甲3'},{cn:'甲4'}] },
        { headword: 'beta', meanings: [{cn:'乙1'},{cn:'乙2'},{cn:'乙3'},{cn:'乙4'}] },
      ],
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a,b)=>a.order-b.order)
    const now = Date.now()
    for (const [index, count] of [[0, 2], [1, 1]] as const) {
      const word = words[index]!
      await db.packItems.put({
        id: `qa-${word.id}:1`, packId: `qa-${word.id}`, seq: 1, wordId: word.id,
        headword: word.headword, headwordLower: word.headwordLower,
        payload: { headword: word.headword, coreSenses: Array.from({ length: count }, (_, k) => ({ index: k + 1, label: `本义${k + 1}` })) },
        status: 'applied', contentHashes: [], createdAt: now, appliedAt: now,
      })
    }
    const result = await buildMultiKindGenerationTargets({ kinds: Object.keys(COUNTS) as never, wordIds: words.map((word) => word.id) })
    expect(result.targets).toHaveLength(34)
  })

  it('真实创建 job：2词/34 targets 保留 34 个唯一 targetKey', async () => {
    await resetDatabase()
    const deck = await createDeck({
      name: 'qa-34-real',
      words: [
        { headword: 'alpha', meanings: [{cn:'甲1'},{cn:'甲2'},{cn:'甲3'},{cn:'甲4'}] },
        { headword: 'beta', meanings: [{cn:'乙1'},{cn:'乙2'},{cn:'乙3'},{cn:'乙4'}] },
      ],
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a,b)=>a.order-b.order)
    const now = Date.now()
    for (const [index, count] of [[0, 2], [1, 1]] as const) {
      const word = words[index]!
      await db.packItems.put({
        id: `qa-real-${word.id}:1`, packId: `qa-real-${word.id}`, seq: 1, wordId: word.id,
        headword: word.headword, headwordLower: word.headwordLower,
        payload: { headword: word.headword, coreSenses: Array.from({ length: count }, (_, k) => ({ index: k + 1, label: `本义${k + 1}` })) },
        status: 'applied', contentHashes: [], createdAt: now, appliedAt: now,
      })
    }
    const built = await buildMultiKindGenerationTargets({ kinds: Object.keys(COUNTS) as never, wordIds: words.map((word) => word.id) })
    expect(built.targets).toHaveLength(34)
    const job = await createGenerationJob({
      kind: 'examples', kinds: Object.keys(COUNTS) as never, source: 'selected', config: { kinds: Object.keys(COUNTS) },
      targets: built.targets.map((target) => ({
        wordId: target.wordId, headword: target.headword, kind: target.kind,
        ...(target.targetKey ? { targetKey: target.targetKey } : {}),
        ...(target.meaningIndex != null ? { meaningIndex: target.meaningIndex } : {}),
        ...(target.coreSenseIndex != null ? { coreSenseIndex: target.coreSenseIndex } : {}),
      })),
    })
    // 真实 job 创建后 targetKey 必须 34 个唯一（QA 合成 seed 缺 targetKey 的回归）
    expect(new Set((await getGenerationJob(job.id))!.targets!.map((t) => t.targetKey ?? t.wordId)).size).toBe(34)
    expect(job.targets).toHaveLength(34)
  })

  it('10 类型 34 targets → results=34、processed=34、completed', async () => {
    const kinds = Object.keys(COUNTS)
    const targets: ReturnType<typeof targetsFor> = []
    let offset = 0
    for (const kind of kinds) {
      targets.push(...targetsFor(kind, COUNTS[kind]!, offset))
      offset += COUNTS[kind]!
    }
    expect(targets).toHaveLength(34)
    const job = await createGenerationJob({ kind: 'examples', kinds: kinds as never, source: 'selected', targets, config: { kinds } })
    const result = await runGenerationJob({
      jobId: job.id,
      config,
      batchSize: 5,
      concurrency: 3,
      deps: { provider: providerForAll() },
    })
    expect(result.processed).toBe(34)
    expect(result.total).toBe(34)
    expect(result.items).toHaveLength(34)
    if (!result.items.every((item) => !item.error)) console.log('RUNNER_ERRORS', JSON.stringify(result.items.filter((item) => item.error)))
    expect(result.items.every((item) => !item.error)).toBe(true)
    const saved = (await getGenerationJob(job.id))!
    expect(saved.status).toBe('completed')
    expect(saved.cursor).toBe(34)
    expect(saved.results).toHaveLength(34)
    expect(new Set(saved.results.map((row) => row.targetKey)).size).toBe(34)
    expect(await getGenerationJobProgress(job.id)).toMatchObject({ processed: 34, total: 34, success: 34, failed: 0, percent: 100, status: 'completed' })
  })
})
