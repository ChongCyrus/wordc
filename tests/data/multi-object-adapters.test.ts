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
