import '../test-utils'
import { describe, expect, it } from 'vitest'
import { createDeck, getDb, resetDatabase } from '../../../src/data'
import {
  generateDerivationMapsBatch,
  listDerivationBatchCandidates,
  type DerivationBatchItem,
} from '../../../src/data/ai/derivation-batch'
import type { AiConfig } from '../../../src/data/ai/types'
import type { LlmProvider } from '../../../src/data/ai/provider'

const CFG = {
  provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
  apiKey: 'test-key', transport: 'browser', batchSize: 1, maxCostPerRun: 3, timeoutMs: 60_000,
} as unknown as AiConfig

function item(word: string, wordId = word): DerivationBatchItem {
  return { wordId, word, meanings: [{ index: 1, cn: `${word}含义`, pos: 'n.' }] }
}

function fakeProvider(opts: { failWords?: string[]; onCall?: () => void } = {}): LlmProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id: 'deepseek', calls,
    async chat(body: Parameters<LlmProvider['chat']>[0]) {
      const user = body.messages[1]!.content
      const word = /word = (\S+)/.exec(user)?.[1] ?? ''
      calls.push(word)
      opts.onCall?.()
      if (opts.failWords?.includes(word)) throw Object.assign(new Error('mock fail'), { code: 'AI_BAD_RESPONSE' })
      const payload = {
        rootLabel: '核心',
        text: `本义/核心义：核心\n- ${word} 含义`,
        lines: [{ text: `${word} 含义`, meaningIndexes: [1] }],
      }
      return { text: JSON.stringify(payload), usage: { input: 1, output: 1, total: 2 } }
    },
  } as unknown as LlmProvider & { calls: string[] }
}

describe('task-171/F11：批量引申图编排', () => {
  it('并发 2、单条失败继续、onSaved 每条成功、不自动重试', async () => {
    const provider = fakeProvider({ failWords: ['bad'] })
    let active = 0
    let maxActive = 0
    const result = await generateDerivationMapsBatch(
      [item('alpha'), item('bad'), item('gamma'), item('delta')],
      CFG,
      {
        concurrency: 2,
        provider,
        onProgress: () => undefined,
        onSaved: async () => { active += 1; maxActive = Math.max(maxActive, active); active -= 1 },
      },
    )
    expect(result.calls).toBe(4)
    expect(result.succeeded.map((row) => row.wordId)).toEqual(['alpha', 'gamma', 'delta'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.wordId).toBe('bad')
    expect(provider.calls.filter((word) => word === 'bad')).toHaveLength(1)
    expect(result.stopped).toBe(false)
    expect(maxActive).toBe(1)
  })

  it('Abort 后不再启动新词，剩余标记 skipped；不重试', async () => {
    const controller = new AbortController()
    const provider = fakeProvider({ onCall: () => controller.abort() })
    const result = await generateDerivationMapsBatch(
      [item('a'), item('b'), item('c')],
      CFG,
      { concurrency: 1, provider, signal: controller.signal },
    )
    expect(result.stopped).toBe(true)
    expect(result.calls).toBe(1)
    expect(result.skipped.map((row) => row.wordId)).toEqual(['a', 'b', 'c'])
  })

  it('onSaved 抛错按该条失败，不自动保存/不重试', async () => {
    const provider = fakeProvider()
    const result = await generateDerivationMapsBatch([item('alpha')], CFG, {
      provider,
      onSaved: () => { throw new Error('save failed') },
    })
    expect(result.failed[0]!.wordId).toBe('alpha')
    expect(result.calls).toBe(1)
  })

  it('选词辅助：deck 过滤、默认排除已有 derivationMap、上限 200', async () => {
    await resetDatabase()
    const deck = await createDeck({
      name: 'd', words: [
        { headword: 'alpha', meanings: [{ cn: '甲', pos: 'n.' }] },
        { headword: 'beta', meanings: [{ cn: '乙', pos: 'v.' }] },
      ],
    })
    const words = await getDb().words.where('deckId').equals(deck.id).toArray()
    await getDb().words.update(words[0]!.id, {
      derivationMap: { rootLabel: '甲', text: '本义/核心义：甲', source: 'manual', updatedAt: Date.now() },
    })
    const missing = await listDerivationBatchCandidates({ deckId: deck.id })
    expect(missing.items.map((row) => row.word)).toEqual(['beta'])
    expect(missing.total).toBe(1)
    const all = await listDerivationBatchCandidates({ deckId: deck.id, includeGenerated: true })
    expect(all.items).toHaveLength(2)
    expect(all.items[0]!.meanings[0]).toMatchObject({ index: 1, cn: '甲', pos: 'n.' })
  })
})

/** task-194：单条挂起 provider（忽略 abort，模拟真实卡住） */
function hangProvider(opts: { hangWords: string[]; hangOnce?: boolean }): LlmProvider & { calls: string[] } {
  const calls: string[] = []
  const seen: Record<string, number> = {}
  return {
    id: 'deepseek',
    calls,
    async chat(body: Parameters<LlmProvider['chat']>[0]) {
      const user = body.messages[1]!.content
      const word = /word = (\S+)/.exec(user)?.[1] ?? ''
      calls.push(word)
      seen[word] = (seen[word] ?? 0) + 1
      if (opts.hangWords.includes(word) && (!opts.hangOnce || seen[word] === 1)) {
        return new Promise<never>(() => undefined) // 永不 resolve/不响应 abort
      }
      return {
        text: JSON.stringify({ rootLabel: '核心', text: `本义/核心义：核心\n- ${word} 含义`, lines: [{ text: `${word} 含义`, meaningIndexes: [1] }] }),
        usage: { input: 1, output: 1, total: 2 },
      }
    },
  } as unknown as LlmProvider & { calls: string[] }
}

describe('task-194：单条 30s-ish 超时 + AI 超时失败自动重试一次', () => {
  it('1 条挂起、其余完成：只该条失败，其他 worker 继续（不阻塞整批）', async () => {
    const provider = hangProvider({ hangWords: ['slow'] })
    const result = await generateDerivationMapsBatch(
      [item('slow'), item('alpha'), item('beta')],
      CFG,
      { concurrency: 2, provider, requestTimeoutMs: 20, autoRetryTimeouts: true },
    )
    expect(result.succeeded.map((row) => row.wordId).sort()).toEqual(['alpha', 'beta'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.wordId).toBe('slow')
    expect(result.failed[0]!.code).toBe('AI_TIMEOUT')
    // slow 首次 + 自动重试一次 = 2 次；alpha/beta 各 1 次
    expect(provider.calls.filter((word) => word === 'slow')).toHaveLength(2)
    expect(result.calls).toBe(4)
    expect(result.retried).toBe(1)
    expect(result.stopped).toBe(false)
  })

  it('超时失败项自动重试一次成功 → 从 failed 移到 succeeded', async () => {
    const provider = hangProvider({ hangWords: ['slow'], hangOnce: true })
    const result = await generateDerivationMapsBatch([item('slow'), item('alpha')], CFG, {
      concurrency: 2,
      provider,
      requestTimeoutMs: 20,
    })
    expect(result.failed).toEqual([])
    expect(result.succeeded.map((row) => row.wordId).sort()).toEqual(['alpha', 'slow'])
    expect(result.retried).toBe(1)
    expect(provider.calls.filter((word) => word === 'slow')).toHaveLength(2)
  })

  it('重试仍挂起 → 最终失败并提示自动重试仍超时', async () => {
    const provider = hangProvider({ hangWords: ['slow'] })
    const result = await generateDerivationMapsBatch([item('slow')], CFG, {
      provider,
      requestTimeoutMs: 20,
    })
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.message).toContain('自动重试仍超时')
    expect(result.calls).toBe(2)
  })

  it('autoRetryTimeouts=false 只尝试一次', async () => {
    const provider = hangProvider({ hangWords: ['slow'] })
    const result = await generateDerivationMapsBatch([item('slow')], CFG, {
      provider,
      requestTimeoutMs: 20,
      autoRetryTimeouts: false,
    })
    expect(result.failed).toHaveLength(1)
    expect(result.calls).toBe(1)
    expect(result.retried).toBe(0)
  })

  it('超时只失败单条：并发 2 下其它 worker 不被 abort', async () => {
    const provider = hangProvider({ hangWords: ['slow'] })
    const result = await generateDerivationMapsBatch(
      [item('slow'), item('alpha'), item('beta'), item('gamma')],
      CFG,
      { concurrency: 2, provider, requestTimeoutMs: 25, autoRetryTimeouts: false },
    )
    expect(result.succeeded.map((row) => row.wordId).sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(result.failed.map((row) => row.wordId)).toEqual(['slow'])
    expect(result.stopped).toBe(false)
  })
})
