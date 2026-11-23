/** 0.4.1/task-285：单请求多对象解析/缺失回退/格式错误回退/批量限制 */
import './test-utils'
import { describe, expect, it } from 'vitest'
import {
  buildMultiObjectUserPrompt,
  chunkMultiObjectSources,
  clampMultiObjectSize,
  generateMultiObject,
  parseMultiObjectResponse,
  type MultiObjectSource,
} from '../../src/data'

const sources: MultiObjectSource[] = [
  { wordId: 'w1', headword: 'alpha' },
  { wordId: 'w2', headword: 'beta' },
  { wordId: 'w3', headword: 'gamma' },
]
const config = { provider: 'deepseek', baseUrl: 'https://example.invalid', model: 'deepseek-chat', apiKey: 'k', maxCostPerRun: 0 } as never
const validate = (raw: unknown) => {
  const row = raw as { text?: unknown }
  const text = typeof row.text === 'string' ? row.text : ''
  if (!text.trim()) throw new Error('text 不能为空')
  return { text }
}

function providerReturning(text: string, calls: number[] = []) {
  return {
    id: 'deepseek' as const,
    async chat() {
      calls.push(1)
      return { text, usage: { input: 10, output: 5, total: 15 } }
    },
  } as never
}

describe('0.4.1 · multi-object protocol', () => {
  it('一次返回按 wordId 匹配；缺失/非法回退单对象', async () => {
    const fallbackCalls: string[] = []
    const calls: number[] = []
    const result = await generateMultiObject('examples', sources, config, {
      provider: providerReturning(
        JSON.stringify({
          items: [
            { wordId: 'w1', text: 'a' },
            { wordId: 'w2', text: '' }, // 非法 → 回退
            { wordId: 'unknown', text: 'x' }, // 未知忽略
          ],
        }),
        calls,
      ),
      validateItem: validate,
      batchSize: 5,
      fallbackSingle: async (source) => {
        fallbackCalls.push(source.wordId)
        return { text: `fallback-${source.headword}` }
      },
    })
    expect(calls).toHaveLength(1) // 只发一次多对象请求
    expect(fallbackCalls.sort()).toEqual(['w2', 'w3'])
    expect(result.items.map((item) => [item.wordId, (item.payload as { text: string } | undefined)?.text])).toEqual([
      ['w1', 'a'],
      ['w2', 'fallback-beta'],
      ['w3', 'fallback-gamma'],
    ])
    expect(result.fallbackCount).toBe(2)
  })

  it('整包格式错误 → 全部回退；无回退则抛错', async () => {
    const fallbackCalls: string[] = []
    const result = await generateMultiObject('phrases', sources.slice(0, 2), config, {
      provider: providerReturning('not json'),
      validateItem: validate,
      fallbackSingle: async (source) => {
        fallbackCalls.push(source.wordId)
        return { text: 'fb' }
      },
    })
    expect(fallbackCalls).toEqual(['w1', 'w2'])
    expect(result.items.every((item) => item.fallback === true)).toBe(true)
    await expect(
      generateMultiObject('phrases', sources.slice(0, 1), config, {
        provider: providerReturning('not json'),
        validateItem: validate,
      }),
    ).rejects.toBeTruthy()
  })

  it('targetKey：同词多目标按 targetKey 匹配，不互相覆盖', async () => {
    const sameWord = [
      { wordId: 'w1', headword: 'alpha', targetKey: 'examples:w1#m1', context: { meanings: [{ id: 'm1', cn: '甲' }] } },
      { wordId: 'w1', headword: 'alpha', targetKey: 'examples:w1#m2', context: { meanings: [{ id: 'm2', cn: '甲2' }] } },
    ]
    const result = await generateMultiObject('examples', sameWord, config, {
      provider: providerReturning(JSON.stringify({ items: [
        { wordId: 'w1', targetKey: 'examples:w1#m1', text: 'a' },
        { wordId: 'w1', targetKey: 'examples:w1#m2', text: 'b' },
      ] })),
      validateItem: validate,
    })
    expect(result.items.map((item) => [item.targetKey, (item.payload as { text: string }).text])).toEqual([
      ['examples:w1#m1', 'a'],
      ['examples:w1#m2', 'b'],
    ])
  })

  it('batchSize 1–20、chunk、prompt 含 wordId；parse 缺 items 抛错', () => {
    expect(clampMultiObjectSize(0)).toBe(1)
    expect(clampMultiObjectSize(21)).toBe(20)
    expect(clampMultiObjectSize(undefined)).toBe(5)
    const chunks = chunkMultiObjectSources(Array.from({ length: 12 }, (_, i) => ({ wordId: `w${i}`, headword: `h${i}` })), 5)
    expect(chunks.map((chunk) => chunk.length)).toEqual([5, 5, 2])
    const prompt = buildMultiObjectUserPrompt('root-etymology', sources)
    expect(prompt).toContain('w1')
    expect(prompt).toContain('root-etymology')
    expect(() => parseMultiObjectResponse({ nope: 1 }, { kind: 'examples', expected: sources, validateItem: validate })).toThrow()
  })
})
