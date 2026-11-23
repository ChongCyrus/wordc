/** 0.4.1：多对象适配器 examples/mnemonics/root-etymology + run 任务写回 */
import './test-utils'
import { describe, expect, it } from 'vitest'
import {
  createGenerationJob,
  getGenerationJob,
  runMultiObjectGeneration,
  type MultiObjectSource,
} from '../../src/data'

const config = { provider: 'deepseek', baseUrl: 'https://example.invalid', model: 'deepseek-chat', apiKey: 'k', maxCostPerRun: 0 } as never

function providerWith(responses: string[]) {
  let index = 0
  return {
    id: 'deepseek' as const,
    async chat() {
      const text = responses[Math.min(index, responses.length - 1)]!
      index += 1
      return { text, usage: { input: 10, output: 5, total: 15 } }
    },
  } as never
}

const exampleSources: MultiObjectSource[] = [
  { wordId: 'w1', headword: 'alpha', context: { meanings: [{ id: 'm1', cn: '甲' }] } },
  { wordId: 'w2', headword: 'beta', context: { meanings: [{ id: 'm2', cn: '乙' }] } },
]

describe('0.4.1 · multi-object adapters', () => {
  it('examples 一次多对象 + run 写 generationJob 结果', async () => {
    const job = await createGenerationJob({ kind: 'examples', source: 'selected' })
    const result = await runMultiObjectGeneration({
      kind: 'examples',
      sources: exampleSources,
      config,
      batchSize: 5,
      jobId: job.id,
      deps: {
        provider: providerWith([
          JSON.stringify({
            items: [
              { wordId: 'w1', examples: [{ en: 'alpha sentence', cn: '甲句' }] },
              { wordId: 'w2', examples: [{ en: 'beta sentence', cn: '乙句' }] },
            ],
          }),
        ]),
      },
    })
    expect(result.items).toHaveLength(2)
    expect(result.fallbackCount).toBe(0)
    const saved = (await getGenerationJob(job.id))!
    expect(saved.status).toBe('completed')
    expect(saved.cursor).toBe(2)
    expect(saved.results).toHaveLength(2)
    expect(saved.failed).toHaveLength(0)
  })

  it('root-etymology 缺失词回退单对象；part 缺 meaning 失败不落库', async () => {
    const sources: MultiObjectSource[] = [
      { wordId: 'w1', headword: 'transport', context: { meanings: [{ cn: '运输' }] } },
      { wordId: 'w2', headword: 'unbelievable', context: { meanings: [{ cn: '难以置信' }] } },
    ]
    const provider = providerWith([
      JSON.stringify({ items: [{ wordId: 'w1', parts: [{ type: 'root', text: 'port', meaning: '搬运' }] }] }), // w2 缺失
      JSON.stringify({ parts: [{ type: 'root', text: 'believ', meaning: '相信' }], etymology: 'un + believ + able' }), // fallback
    ])
    const result = await runMultiObjectGeneration({
      kind: 'root-etymology',
      sources,
      config,
      deps: { provider },
    })
    expect(result.items).toHaveLength(2)
    expect(result.fallbackCount).toBe(1)
    expect(result.items[0]!.error).toBeUndefined()
    expect(result.items[1]!.fallback).toBe(true)
    expect((result.items[1]!.payload as { parts: unknown[] }).parts).toHaveLength(1)
  })

  it('0.6.0 词级 derivation/rare 适配器', async () => {
    const derivationSources: MultiObjectSource[] = [
      { wordId: 'd1', headword: 'transport', context: { meanings: [{ cn: '运输' }, { cn: '交通' }] } },
    ]
    const deriv = await runMultiObjectGeneration({
      kind: 'derivation',
      sources: derivationSources,
      config,
      deps: {
        provider: providerWith([
          JSON.stringify({ items: [{ wordId: 'd1', rootLabel: 'trans+port', text: '跨越搬运 → 运输' }] }),
        ]),
      },
    })
    expect(deriv.items[0]!.error).toBeUndefined()
    expect((deriv.items[0]!.payload as { rootLabel: string }).rootLabel).toBe('trans+port')

    const rareSources: MultiObjectSource[] = [
      { wordId: 'r1', headword: 'abandon', context: { meanings: [{ cn: '放弃' }, { cn: '抛弃' }], coreSenses: [{ index: 1, label: '本义' }] } },
    ]
    const rare = await runMultiObjectGeneration({
      kind: 'rare-meanings',
      sources: rareSources,
      config,
      deps: {
        provider: providerWith([JSON.stringify({ items: [{ wordId: 'r1', rareMeaningIndexes: [2], rareCoreSenseIndexes: [1] }] })]),
      },
    })
    expect((rare.items[0]!.payload as { rareMeaningIndexes: number[] }).rareMeaningIndexes).toEqual([2])
    expect((rare.items[0]!.payload as { rareCoreSenseIndexes: number[] }).rareCoreSenseIndexes).toEqual([1])
  })

  it('0.6.0 语义级 semantics/overview/meaning-mnemonic 适配器', async () => {
    const sources: MultiObjectSource[] = [
      {
        wordId: 's1', headword: 'company',
        context: { meanings: [{ cn: '公司' }, { cn: '陪伴' }], coreSenses: [{ index: 1, label: '同食同伴' }], meaningIndex: 2 },
      },
    ]
    const semantics = await runMultiObjectGeneration({
      kind: 'semantics',
      sources,
      config,
      deps: {
        provider: providerWith([
          JSON.stringify({ items: [{ wordId: 's1', coreSenses: [{ index: 1, label: '同食同伴', confidence: 'high' }], meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }, { meaningIndex: 2, coreSenseIndex: 1 }] }] }),
        ]),
      },
    })
    expect(semantics.items[0]!.payload).toMatchObject({ coreSenses: [{ label: '同食同伴' }] })

    const overview = await runMultiObjectGeneration({
      kind: 'overview',
      sources,
      config,
      deps: { provider: providerWith([JSON.stringify({ items: [{ wordId: 's1', text: '同食同伴 → 公司/陪伴' }] })]) },
    })
    expect((overview.items[0]!.payload as { text: string }).text).toContain('陪伴')

    const meaningMnemonic = await runMultiObjectGeneration({
      kind: 'meaning-mnemonic',
      sources,
      config,
      deps: {
        provider: providerWith([JSON.stringify({ items: [{ wordId: 's1', mnemonics: [{ type: 'assoc', text: '一起吃饭的人' }] }] })]),
      },
    })
    expect((meaningMnemonic.items[0]!.payload as { mnemonics: unknown[] }).mnemonics).toHaveLength(1)
  })

  it('预算超限停止并写 job paused', async () => {
    const job = await createGenerationJob({ kind: 'examples', source: 'selected' })
    const budgetConfig = { provider: 'deepseek', baseUrl: 'https://example.invalid', model: 'deepseek-chat', apiKey: 'k', maxCostPerRun: 0.0000001 } as never
    await expect(
      runMultiObjectGeneration({
        kind: 'examples',
        sources: exampleSources,
        config: budgetConfig,
        jobId: job.id,
        batchSize: 1,
        concurrency: 2,
        deps: {
          provider: providerWith([
            JSON.stringify({ items: [{ wordId: 'w1', examples: [{ en: 'a', cn: '甲' }] }] }),
            JSON.stringify({ items: [{ wordId: 'w2', examples: [{ en: 'b', cn: '乙' }] }] }),
          ]),
        },
      }),
    ).rejects.toThrow(/AI_COST_LIMIT/)
    const saved = (await getGenerationJob(job.id))!
    expect(saved.status).toBe('paused')
    expect(saved.error).toMatch(/AI_COST_LIMIT/)
    expect(saved.concurrency).toBe(2)
    expect(saved.batchSize).toBe(1)
  })

  it('mnemonics 非法条目触发单对象回退', async () => {
    const provider = providerWith([
      JSON.stringify({ items: [{ wordId: 'w1', mnemonics: [] }] }), // 空 → 回退
      JSON.stringify({ items: [{ headwordLower: 'alpha', headword: 'alpha', mnemonics: [{ type: 'assoc', text: '阿尔法' }] }] }),
    ])
    const result = await runMultiObjectGeneration({
      kind: 'mnemonics',
      sources: [exampleSources[0]!],
      config,
      deps: { provider },
    })
    expect(result.fallbackCount).toBe(1)
    expect(result.items[0]!.fallback).toBe(true)
    expect((result.items[0]!.payload as { mnemonics: unknown[] }).mnemonics).toHaveLength(1)
  })
})

it('0.6.2 续跑：cursor4 + 剩余12 → cursor=16、results=16 唯一', async () => {
  const targets = Array.from({ length: 16 }, (_, i) => ({ wordId: `rw${i}`, headword: `word${i}` }))
  const job = await createGenerationJob({ kind: 'examples', source: 'selected', targets })
  for (let i = 0; i < 4; i += 1) {
    await (await import('../../src/data')).appendGenerationJobResult(job.id, { wordId: `rw${i}`, headword: `word${i}` })
  }
  await (await import('../../src/data')).updateGenerationJob(job.id, { cursor: 4 })
  const provider = {
    id: 'deepseek' as const,
    async chat(body: { messages: Array<{ content: string }> }) {
      const content = body.messages[1]?.content ?? ''
      const ids = [...content.matchAll(/"wordId":"([^"]+)"/g)].map((match) => match[1]!)
      return {
        text: JSON.stringify({
          items: ids.map((wordId) => ({ wordId, examples: [{ en: `${wordId} sentence`, cn: '例句' }] })),
        }),
        usage: { input: 1, output: 1, total: 2 },
      }
    },
  } as never
  const remaining = targets.slice(4).map((target) => ({
    wordId: target.wordId,
    headword: target.headword,
    context: { meanings: [{ id: `${target.wordId}-m`, cn: '义' }] },
  }))
  const result = await runMultiObjectGeneration({
    kind: 'examples',
    sources: remaining,
    config,
    batchSize: 6,
    concurrency: 2,
    jobId: job.id,
    deps: { provider },
  })
  expect(result.items).toHaveLength(12)
  const saved = (await getGenerationJob(job.id))!
  expect(saved.cursor).toBe(16)
  expect(saved.results).toHaveLength(16)
  expect(new Set(saved.results.map((row) => row.wordId)).size).toBe(16)
})
