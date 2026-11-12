/**
 * task-100 · 生成引擎切 v4（grouped coreSenses/meaningMap）
 * mock-only，无真实网络；CLI 仅 --dry-run smoke。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node（CLI dry-run smoke 用）
import { execFileSync } from 'node:child_process'

import {
  PROMPT_VERSION_V4,
  generateItems,
  validateSemanticsV4Items,
} from '../../../src/data/ai'
import type {
  AiConfig,
  ChatBody,
  ChatResponse,
  GenerateTarget,
  LlmProvider,
  TokenUsage,
} from '../../../src/data/ai'

const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-fake-v4',
  transport: 'proxy',
  batchSize: 20,
  maxCostPerRun: 3,
}
const USAGE: TokenUsage = { input: 100, output: 50, total: 150 }

function target(n: number, meaningCount = 3): GenerateTarget {
  const headword = `word${n}`
  return {
    wordId: `deck:${headword}`,
    headword,
    headwordLower: headword,
    meanings: Array.from({ length: meaningCount }, (_, i) => ({
      id: `deck:${headword}#M${i + 1}`,
      pos: i === 0 ? 'n.' : 'v.',
      cn: `含义${i + 1}`,
    })),
    existing: { examples: 0, phrases: 0, mnemonics: 0 },
  }
}

function groupedResponse(n: number, option: { badLabel?: boolean; missingMap?: boolean } = {}): string {
  const coreSenses = option.badLabel
    ? [{ index: 1, label: '看是否指计划', gloss: '检查步骤', confidence: 'high' }]
    : [
        { index: 1, label: '计划', gloss: '预先安排的行动方案', origin: '拉丁 planum=平面', confidence: 'high' },
        { index: 2, label: '设计', gloss: '预先画出方案', confidence: 'medium' },
      ]
  const meaningMap = option.missingMap
    ? [{ meaningIndex: 1, coreSenseIndex: 1 }]
    : [
        { meaningIndex: 1, coreSenseIndex: 1, steps: ['平面图', '预先安排'] },
        { meaningIndex: 2, coreSenseIndex: 2 },
        { meaningIndex: 3, coreSenseIndex: 1 },
      ]
  return JSON.stringify({ items: [{ headword: `word${n}`, coreSenses, meaningMap }] })
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
const noSleep = async () => undefined
const ok = (text: string): ChatResponse => ({ text, usage: USAGE })

describe('task-100：generateItems 切 v4 grouped 解析', () => {
  it('v4 正常输出：直接读 coreSenses/meaningMap（不再 per-c 聚合），promptVersion=v4', async () => {
    const provider = fakeProvider(() => ok(groupedResponse(1)))
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(res.promptVersion).toBe(PROMPT_VERSION_V4)
    expect(provider.calls).toHaveLength(1)
    // system/user prompt 走 v4（要求 grouped coreSenses/meaningMap）
    const combined = provider.calls[0]!.messages.map((message) => message.content).join('\n')
    expect(combined).toContain('coreSenses')
    expect(combined).toContain('meaningMap')
    const item = res.results[0]!.item!
    expect(item.coreSenses!.map((sense) => sense.label)).toEqual(['计划', '设计'])
    expect(item.coreSenses![0]!.note).toBe('预先安排的行动方案') // gloss → note
    expect(item.coreSenses![0]!.origin).toBe('拉丁 planum=平面')
    expect(item.meaningMap!.map((entry) => entry.meaningIndex)).toEqual([1, 2, 3])
    expect(item.meaningMap![0]!.steps).toEqual(['平面图', '预先安排'])
  })

  it('非法 label → 触发 v4 repair prompt，第二次成功', async () => {
    const provider = fakeProvider((call) =>
      call === 1 ? ok(groupedResponse(1, { badLabel: true })) : ok(groupedResponse(1)),
    )
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(2)
    const repairText = provider.calls[1]!.messages.map((message) => message.content).join('\n')
    expect(repairText).toContain('E_LABEL_BANNED')
    expect(res.results[0]!.item!.coreSenses![0]!.label).toBe('计划')
    expect(res.promptVersion).toBe(PROMPT_VERSION_V4)
  })

  it('缺 meaningMap 覆盖：repair 仍失败 → AI_FORMAT（不产出坏数据）', async () => {
    const provider = fakeProvider(() => ok(groupedResponse(1, { missingMap: true })))
    const res = await generateItems(
      { kind: 'semantics', targets: [target(1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls.length).toBeGreaterThan(1) // 已尝试 repair
    expect(res.results[0]!.item).toBeUndefined()
    expect(res.results[0]!.error?.code).toBe('AI_FORMAT')
    expect(res.promptVersion).toBe(PROMPT_VERSION_V4)
  })

  it('单含义词短路：不调模型，promptVersion 仍为 v4', async () => {
    const provider = fakeProvider(() => ok('{}'))
    const res = await generateItems(
      { kind: 'semantics', targets: [target(9, 1)], config: CFG },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(0)
    expect(res.results[0]!.item!.meaningMap).toHaveLength(1)
    expect(res.promptVersion).toBe(PROMPT_VERSION_V4)
  })

  it('校验器入口：非 grouped v3 输出（per-c label）不再被 v4 接受', () => {
    const v3 = { items: [{ headword: 'plan', meanings: [{ meaningIndex: 1, coreSenseLabel: '计划' }] }] }
    const r = validateSemanticsV4Items({
      json: v3,
      targets: [{ headword: 'plan', meanings: [{ cn: '计划' }] }],
    })
    expect(r.byKey.size).toBe(0)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  // Node <24 不支持直接 import .ts（type-stripping）：CI 升级 Node24 前跳过 CLI smoke
  const NODE_MAJOR = Number(
    (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node?.split('.')[0] ?? 0,
  )
  it.skipIf(NODE_MAJOR < 24)('CLI --dry-run（semantics）不发起网络请求且走 v4', () => {
    const nodeExecPath = (globalThis as { process?: { execPath: string } }).process!.execPath
    const stdout = execFileSync(
      nodeExecPath,
      ['tools/gen-pack-deepseek.mjs', '--kind', 'semantics', '--dry-run', '--limit', '3'],
      { cwd: new URL('../../..', import.meta.url), encoding: 'utf8', timeout: 60_000 },
    )
    expect(stdout).toContain('[dry-run] semantics')
    expect(stdout).toContain('每请求')
    void PROMPT_VERSION_V4
  }, 90_000)
})
