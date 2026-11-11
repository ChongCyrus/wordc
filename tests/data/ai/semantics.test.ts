/**
 * task-76 · prompt v3.4 本义标注（per-c coreSenseLabel → 程序聚合）
 * mock-only，无真实网络。
 * 覆盖：同 label 聚合 / 不同 label 分开 / label 归一（空白/全半角/大小写）/ label 缺失回退 note /
 *       覆盖不全重试 / 坏 JSON / confidence 聚合 / steps / 单含义跳过。
 */
import { describe, expect, it } from 'vitest'
import {
  PROMPT_VERSION_V3,
  aggregateSemanticsLabels,
  buildSemanticsRepairPromptV3,
  buildSystemPromptV3,
  buildUserPromptV3,
  generateItems,
  normalizeCoreSenseLabel,
} from '../../../src/data/ai'
import type {
  AiConfig,
  ChatBody,
  ChatResponse,
  GenerateTarget,
  LlmProvider,
  SemanticsValidateTarget,
  TokenUsage,
} from '../../../src/data/ai'

const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-fake-v34-1',
  transport: 'proxy',
  batchSize: 20,
  maxCostPerRun: 3,
  proxyUrl: 'http://127.0.0.1:8788',
}
const USAGE: TokenUsage = { input: 120, output: 80, total: 200 }

function target(n: number, meaningCount = 2): GenerateTarget {
  const headword = `word${n}`
  return {
    wordId: `deck:${headword}`,
    headword,
    headwordLower: headword,
    meanings: Array.from({ length: meaningCount }, (_, i) => ({
      id: `deck:${headword}#M${i + 1}`,
      pos: i === 1 ? 'v.' : 'n.',
      cn: i === 0 ? '含义一' : '含义二',
    })),
    existing: { examples: 0, phrases: 0, mnemonics: 0 },
  }
}

interface FakeProvider extends LlmProvider {
  calls: ChatBody[]
}
function fakeProvider(handler: (call: number, body: ChatBody) => ChatResponse | Promise<ChatResponse>): FakeProvider {
  const calls: ChatBody[] = []
  return {
    id: 'deepseek',
    calls,
    async chat(body) {
      calls.push(body)
      return handler(calls.length, body)
    },
  }
}
const ok = (text: string): ChatResponse => ({ text, usage: USAGE })
const noSleep = async () => undefined

/** v3.4 合法输出：两个 c 同属一个本义 */
function payloadSameLabel(n: number, label = '同食同伴'): string {
  return JSON.stringify({
    items: [
      {
        headword: `word${n}`,
        meanings: [
          { meaningIndex: 1, coreSenseLabel: label, coreSenseNote: '一起吃饭的人', confidence: 'high' },
          // 同一本义：label 逐字相同（带不同空白/大小写也应由程序归一）
          { meaningIndex: 2, coreSenseLabel: label, confidence: 'high' },
        ],
      },
    ],
  })
}

/** v3.4 合法输出：两个 c 分属两个本义 */
function payloadTwoLabels(n: number): string {
  return JSON.stringify({
    items: [
      {
        headword: `word${n}`,
        meanings: [
          { meaningIndex: 1, coreSenseLabel: '学习动作', confidence: 'high', steps: ['学习', '学习动作'] },
          { meaningIndex: 2, coreSenseLabel: '获得知识', confidence: 'medium' },
        ],
      },
    ],
  })
}

describe('ai/semantics v3.4 · 纯模块可被 Node CLI 直接 import（自包含）', () => {
  it('semantics.ts 运行时只 import zod，无相对路径运行时 import', () => {
    const modules = import.meta.glob<string>('../../../src/data/ai/semantics.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const source = Object.values(modules)[0] ?? ''
    const runtimeImports = source
      .split('\n')
      .filter((line) => /^\s*import\s+/.test(line) && !/^\s*import\s+type\s+/.test(line))
      .join('\n')
    expect(runtimeImports).toContain("from 'zod'")
    expect(runtimeImports).not.toMatch(/from '\.\.?\//)
  })
})

describe('ai/semantics v3.4 · prompt 契约', () => {
  it('版本/系统 prompt：per-c coreSenseLabel、逐字一致、不硬拆不硬合', () => {
    expect(PROMPT_VERSION_V3).toBe('v3.7-semantics')
    const system = buildSystemPromptV3()
    expect(system).toContain(PROMPT_VERSION_V3)
    expect(system).toContain('coreSenseLabel')
    expect(system).toContain('逐字完全相同')
    expect(system).toContain('本义」是一个集合/多值映射，不是唯一值')
    expect(system).toContain('先识别本义集合')
    expect(system).toContain('1–4 个')
    expect(system).toContain('不要把「本义」误解成「全词只有一个本义」')
    expect(system).toContain('不要因为「本义」这个词，就把全词所有 c 硬塞进同一个 label')
    expect(system).toContain('同一个本义')
    expect(system).toContain('同食同伴')
    // v3.6：大本义（≥6 c）再拆规则 + 多义共享本义说明
    expect(system).toContain('≥6 个 c')
    expect(system).toContain('2–4 个更细的本义')
    expect(system).toContain('多义共享本义')
    expect(system).toContain('charge')
    expect(system).toContain('abstract')
    expect(system).toContain('steps 必须体现细分差异')
    // v3.7：≥8 c 且跨词性大类必须拆
    expect(system).toContain('≥8 个 c')
    expect(system).toContain('跨词性大类必拆')
    expect(system).toContain('即使词源同源也必须至少拆 2 个')
    expect(system).toContain('严格 JSON')

    const wordPrompt = buildUserPromptV3('word1', [
      { cn: '含义一', pos: 'n.' },
      { cn: '含义二', pos: 'v.' },
    ])
    expect(wordPrompt).toContain('word1')
    expect(wordPrompt).toContain('"meaningIndex":1')
    expect(wordPrompt).toContain('"meaningIndex":2')
    expect(wordPrompt).toContain('coreSenseLabel')

    const repair = buildSemanticsRepairPromptV3('targets = []', '缺少含义 2')
    expect(repair).toContain('缺少含义 2')
    expect(repair).toContain('coreSenseLabel')
  })

  it('normalizeCoreSenseLabel：NFKC/空白/大小写归一', () => {
    expect(normalizeCoreSenseLabel('  同食同伴 ')).toBe('同食同伴')
    expect(normalizeCoreSenseLabel('Company')).toBe('company')
    expect(normalizeCoreSenseLabel('co mpany')).toBe('company')
    expect(normalizeCoreSenseLabel('ＡＢＣ')).toBe('abc') // 全角→半角
    expect(normalizeCoreSenseLabel('  ')).toBe('')
  })
})

describe('ai/semantics v3.4 · label 聚合（程序侧）', () => {
  it('同一 label 的多个 c → 1 个 coreSense，全部映射到该本义', () => {
    const t = target(1)
    const { byKey, error } = aggregateSemanticsLabels({ json: JSON.parse(payloadSameLabel(1)), targets: [t] })
    expect(error).toBeUndefined()
    const item = byKey.get('word1')!
    expect(item.coreSenses).toHaveLength(1)
    expect(item.coreSenses?.[0]).toMatchObject({ index: 1, label: '同食同伴', confidence: 'high' })
    // 首个 c 的 coreSenseNote 已作为 coreSense.note 展示，meaningMap 不重复
    expect(item.meaningMap).toEqual([
      { meaningIndex: 1, coreSenseIndex: 1 },
      { meaningIndex: 2, coreSenseIndex: 1 },
    ])
  })

  it('label 归一后相同（空白/全半角/大小写）→ 聚合为同一本义', () => {
    const t = target(1)
    const json = {
      items: [
        {
          headword: 'word1',
          meanings: [
            { meaningIndex: 1, coreSenseLabel: 'Company', confidence: 'high' },
            { meaningIndex: 2, coreSenseLabel: 'ｃｏｍｐａｎｙ ', confidence: 'medium' },
          ],
        },
      ],
    }
    const { byKey } = aggregateSemanticsLabels({ json, targets: [t] })
    const item = byKey.get('word1')!
    expect(item.coreSenses).toHaveLength(1)
    expect(item.coreSenses?.[0]?.label).toBe('Company') // 展示用首个原始 label
    expect(item.coreSenses?.[0]?.confidence).toBe('medium') // 取最弱
    expect(item.meaningMap?.map((m) => m.coreSenseIndex)).toEqual([1, 1])
  })

  it('不同 label → 不同 coreSenses（程序自行分开）', () => {
    const t = target(1)
    const { byKey } = aggregateSemanticsLabels({ json: JSON.parse(payloadTwoLabels(1)), targets: [t] })
    const item = byKey.get('word1')!
    expect(item.coreSenses?.map((s) => s.label)).toEqual(['学习动作', '获得知识'])
    expect(item.coreSenses?.[0]?.confidence).toBe('high')
    expect(item.coreSenses?.[1]?.confidence).toBe('medium')
    expect(item.meaningMap).toEqual([
      { meaningIndex: 1, coreSenseIndex: 1, steps: ['学习', '学习动作'] },
      { meaningIndex: 2, coreSenseIndex: 2 },
    ])
  })

  it('label 缺失 → 回退 coreSenseNote；两者都缺失 → 「未标注」+ low', () => {
    const t = target(1)
    const json = {
      items: [
        {
          headword: 'word1',
          meanings: [
            { meaningIndex: 1, coreSenseNote: '一起吃饭的人', confidence: 'high' },
            { meaningIndex: 2, confidence: 'high' },
          ],
        },
      ],
    }
    const { byKey } = aggregateSemanticsLabels({ json, targets: [t] })
    const item = byKey.get('word1')!
    expect(item.coreSenses?.map((s) => s.label)).toEqual(['一起吃饭的人', '未标注'])
    expect(item.coreSenses?.[1]?.confidence).toBe('low')
    expect(item.meaningMap).toHaveLength(2)
  })

  it('覆盖不全（缺少 meaningIndex）→ 返回 error（供 generate 修复重试）', () => {
    const t = target(1)
    const json = {
      items: [{ headword: 'word1', meanings: [{ meaningIndex: 1, coreSenseLabel: 'A', confidence: 'high' }] }],
    }
    const { error } = aggregateSemanticsLabels({ json, targets: [t] })
    expect(error).toContain('缺少含义 2')
  })

  it('重复 meaningIndex 保留第一条；steps 过滤空/trim', () => {
    const t = target(1)
    const json = {
      items: [
        {
          headword: 'word1',
          meanings: [
            { meaningIndex: 1, coreSenseLabel: 'A', confidence: 'high', steps: [' x ', '', 'y'] },
            { meaningIndex: 1, coreSenseLabel: 'B', confidence: 'low' },
            { meaningIndex: 2, coreSenseLabel: 'A', confidence: 'high' },
          ],
        },
      ],
    }
    const { byKey } = aggregateSemanticsLabels({ json, targets: [t] })
    const item = byKey.get('word1')!
    expect(item.coreSenses).toHaveLength(1)
    expect(item.meaningMap).toEqual([
      { meaningIndex: 1, coreSenseIndex: 1, steps: ['x', 'y'] },
      { meaningIndex: 2, coreSenseIndex: 1 },
    ])
  })
})

describe('ai/semantics v3.4 · generate 端到端（mock）', () => {
  it('成功：per-c label 聚合为 coreSenses/meaningMap；usage/cost 正常', async () => {
    const provider = fakeProvider(() => ok(payloadSameLabel(1)))
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(1)
    const item = res.results[0]!.item!
    expect(item.coreSenses).toHaveLength(1)
    expect(item.coreSenses?.[0]?.label).toBe('同食同伴')
    expect(item.meaningMap).toHaveLength(2)
    expect(res.usage).toEqual(USAGE)
    expect(res.costYuan).toBeGreaterThan(0)
  })

  it('不同 label 分开（学习/获得知识）', async () => {
    const provider = fakeProvider(() => ok(payloadTwoLabels(1)))
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(res.results[0]!.item!.coreSenses?.map((s) => s.label)).toEqual(['学习动作', '获得知识'])
  })

  it('批量多个词：一次调用多项、顺序对应', async () => {
    const provider = fakeProvider(() =>
      ok(
        JSON.stringify({
          items: [
            { headword: 'word1', meanings: [{ meaningIndex: 1, coreSenseLabel: 'A', confidence: 'high' }, { meaningIndex: 2, coreSenseLabel: 'A', confidence: 'high' }] },
            { headword: 'word2', meanings: [{ meaningIndex: 1, coreSenseLabel: 'B', confidence: 'high' }, { meaningIndex: 2, coreSenseLabel: 'C', confidence: 'high' }] },
          ],
        }),
      ),
    )
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1), target(2)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(1)
    expect(res.results[0]!.item!.coreSenses).toHaveLength(1)
    expect(res.results[1]!.item!.coreSenses).toHaveLength(2)
  })

  it('单含义词跳过：不调模型、usage=0、code 返回自身映射', async () => {
    const provider = fakeProvider(() => {
      throw new Error('单含义词不应调用模型')
    })
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1, 1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(0)
    expect(res.usage.total).toBe(0)
    expect(res.costYuan).toBe(0)
    expect(res.results[0]!.item?.meaningMap).toEqual([{ meaningIndex: 1, coreSenseIndex: 1, note: '唯一义项' }])
  })

  it('覆盖不全 → 修复重试一次后成功（第二次 prompt 带缺失说明）', async () => {
    const provider = fakeProvider((n) =>
      n === 1
        ? ok(JSON.stringify({ items: [{ headword: 'word1', meanings: [{ meaningIndex: 1, coreSenseLabel: 'A', confidence: 'high' }] }] }))
        : ok(payloadSameLabel(1)),
    )
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(2)
    expect(res.results[0]!.error).toBeUndefined()
    const repairUser = provider.calls[1]!.messages.find((m) => m.role === 'user')!.content
    expect(repairUser).toContain('缺少含义')
  })

  it('覆盖持续不全 → 3 次后 AI_FORMAT', async () => {
    const provider = fakeProvider(() =>
      ok(JSON.stringify({ items: [{ headword: 'word1', meanings: [{ meaningIndex: 1, coreSenseLabel: 'A', confidence: 'high' }] }] })),
    )
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(3)
    expect(res.results[0]!.error?.code).toBe('AI_FORMAT')
  })

  it('坏 JSON → 修复重试成功', async () => {
    const provider = fakeProvider((n) => (n === 1 ? ok('不是 JSON') : ok(payloadSameLabel(1))))
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(2)
    expect(res.results[0]!.error).toBeUndefined()
  })

  it('confidence 缺失 → low（聚合取最弱）', async () => {
    const provider = fakeProvider(() =>
      ok(
        JSON.stringify({
          items: [
            {
              headword: 'word1',
              meanings: [
                { meaningIndex: 1, coreSenseLabel: 'A' },
                { meaningIndex: 2, coreSenseLabel: 'A', confidence: 'high' },
              ],
            },
          ],
        }),
      ),
    )
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(res.results[0]!.item!.coreSenses?.[0]?.confidence).toBe('low')
  })
})

describe('ai/semantics v3.4 · 聚合函数输入（CLI 复用）', () => {
  it('SemanticsValidateTarget 最小形状可直接用', () => {
    const targets: SemanticsValidateTarget[] = [{ headword: 'word1', meanings: [{ cn: '含义一' }, { cn: '含义二' }] }]
    const { byKey } = aggregateSemanticsLabels({ json: JSON.parse(payloadSameLabel(1)), targets })
    expect(byKey.get('word1')?.coreSenses).toHaveLength(1)
  })
})
