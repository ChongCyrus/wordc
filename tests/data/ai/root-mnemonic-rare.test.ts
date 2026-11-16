/** 0.3.61 AI mock：root mnemonic / rare meanings / batch 预算与错误隔离 */
import { describe, expect, it } from 'vitest'
import {
  PROMPT_VERSION_RARE_MEANINGS,
  PROMPT_VERSION_ROOT_MNEMONIC,
} from '../../../src/data/ai/prompts'
import {
  generateRareMeanings,
  generateRareMeaningsBatch,
  generateRootMnemonic,
  validateRareMeaningsDraft,
  validateRootMnemonicDraft,
} from '../../../src/data/ai'
import type { AiConfig, ChatBody, ChatResponse, LlmProvider, TokenUsage } from '../../../src/data/ai'

const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-fake',
  transport: 'auto',
  batchSize: 20,
  maxCostPerRun: 3,
  jsonMode: true,
}
const USAGE: TokenUsage = { input: 100, output: 50, total: 150 }
const ok = (text: string): ChatResponse => ({ text, usage: USAGE })

function provider(handler: (call: number, body: ChatBody) => ChatResponse | Promise<ChatResponse>): LlmProvider & { calls: ChatBody[] } {
  const calls: ChatBody[] = []
  return {
    id: 'deepseek',
    calls,
    async chat(body) { calls.push(body); return handler(calls.length, body) },
  }
}

describe('0.3.61 · AI root mnemonic', () => {
  it('合法 1–3 条；prompt 采用 v1.0；输入包含 word/rootLabel/第一段', async () => {
    expect(PROMPT_VERSION_ROOT_MNEMONIC).toBe('v1.0-root-mnemonic')
    const p = provider(() => ok(JSON.stringify({ mnemonics: [{ text: 'margin+al：在边缘的' }, { text: '页边批注联想' }] })))
    const result = await generateRootMnemonic(
      { word: 'marginal', rootLabel: '边缘', firstParagraph: '边缘 → 次要的' },
      CFG,
      { provider: p },
    )
    expect(result.promptVersion).toBe(PROMPT_VERSION_ROOT_MNEMONIC)
    expect(result.mnemonics).toEqual(['margin+al：在边缘的', '页边批注联想'])
    const prompt = p.calls[0]!.messages.map((message) => message.content).join('\n')
    expect(prompt).toContain('marginal')
    expect(prompt).toContain('边缘')
    expect(prompt).toContain('次要的')
  })

  it('非法：0/4 条、缺 mnemonics', async () => {
    expect(() => validateRootMnemonicDraft({ mnemonics: [] })).toThrow(/1–3/)
    expect(() => validateRootMnemonicDraft({ mnemonics: [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }] })).toThrow(/1–3/)
    expect(() => validateRootMnemonicDraft({})).toThrow(/缺少 mnemonics/)
    const p = provider(() => ok('{}'))
    await expect(generateRootMnemonic({ word: 'x', rootLabel: 'y' }, CFG, { provider: p })).rejects.toThrow(/缺少 mnemonics/)
  })
})

describe('0.3.61 · AI rare meanings', () => {
  const source = {
    word: 'marginal',
    meanings: [
      { index: 1, cn: '边缘的', pos: 'adj.' },
      { index: 2, cn: '边际', pos: 'n.' },
      { index: 3, cn: '边际席位（生僻）', pos: 'n.' },
    ],
  }

  it('合法：空数组（不标）/指定索引；去重排序；版本 v1.0', async () => {
    expect(PROMPT_VERSION_RARE_MEANINGS).toBe('v1.0-rare-meanings')
    const empty = provider(() => ok(JSON.stringify({ rareMeaningIndexes: [] })))
    const a = await generateRareMeanings(source, CFG, { provider: empty })
    expect(a.rareMeaningIndexes).toEqual([])
    expect(a.promptVersion).toBe(PROMPT_VERSION_RARE_MEANINGS)
    const prompt = empty.calls[0]!.messages.map((message) => message.content).join('\n')
    expect(prompt).toContain('没有就不标')
    expect(prompt).toContain('边际席位')

    const some = provider(() => ok(JSON.stringify({ rareMeaningIndexes: [3, 1, 3] })))
    const b = await generateRareMeanings(source, CFG, { provider: some })
    expect(b.rareMeaningIndexes).toEqual([1, 3])
  })

  it('非法索引/缺数组直接 AI_FORMAT', async () => {
    expect(() => validateRareMeaningsDraft({ rareMeaningIndexes: [0] }, 3)).toThrow(/1\.\.3/)
    expect(() => validateRareMeaningsDraft({ rareMeaningIndexes: [4] }, 3)).toThrow(/1\.\.3/)
    expect(() => validateRareMeaningsDraft({ rareMeaningIndexes: ['1'] }, 3)).toThrow(/1\.\.3/)
    expect(() => validateRareMeaningsDraft({}, 3)).toThrow(/缺少 rareMeaningIndexes/)
  })

  it('batch：逐词失败不中断、累计 usage/cost；超预算预检拒绝开始', async () => {
    const p = provider((call) => {
      if (call === 2) return ok('not json')
      return ok(JSON.stringify({ rareMeaningIndexes: call === 3 ? [2] : [] }))
    })
    const result = await generateRareMeaningsBatch(
      [source, { ...source, word: 'bad1' }, { ...source, word: 'bad2' }],
      CFG,
      { provider: p, concurrency: 1 },
    )
    expect(result.results).toHaveLength(3)
    expect(result.results[1]!.error).toBeTruthy()
    expect(result.results[0]!.rareMeaningIndexes).toEqual([])
    expect(result.results[2]!.rareMeaningIndexes).toEqual([2])
    expect(result.usage.total).toBeGreaterThan(0)
    expect(result.costYuan).toBeGreaterThan(0)

    const tiny: AiConfig = { ...CFG, maxCostPerRun: 0.0001 }
    await expect(
      generateRareMeaningsBatch(Array.from({ length: 30 }, () => source), tiny, { provider: p }),
    ).rejects.toThrow(/超过单次上限/)
  })
})
