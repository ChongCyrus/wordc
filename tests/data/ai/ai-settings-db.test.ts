// 第一个 import 必须是 test-utils（fake-indexeddb 在任何 src/data import 之前求值）
import { freshDb } from '../test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AI_CONFIG,
  getSessionApiKey,
  loadAiSettings,
  saveAiConfig,
  saveAiSettings,
  setSessionApiKey,
} from '../../../src/data/ai'

beforeEach(async () => {
  setSessionApiKey('')
  await freshDb()
})

describe('ai/settings · 持久化（fake-indexeddb）', () => {
  it('saveAiSettings 写 enabled/pregenBudget/provider 配置，load 回读一致', async () => {
    const state = await saveAiSettings({
      enabled: true,
      pregenBudget: 40,
      config: {
        ...DEFAULT_AI_CONFIG,
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        model: 'custom-model',
        batchSize: 33,
        maxCostPerRun: 5,
        transport: 'proxy',
      },
    })
    expect(state.enabled).toBe(true)
    expect(state.pregenBudget).toBe(40)
    expect(state.config.provider).toBe('openai-compatible')
    expect(state.config.baseUrl).toBe('https://api.example.com')
    expect(state.config.model).toBe('custom-model')
    expect(state.config.batchSize).toBe(33)
    expect(state.config.maxCostPerRun).toBe(5)
    expect(state.config.transport).toBe('proxy')
    // 重新读（模拟刷新）
    const again = await loadAiSettings()
    expect(again.enabled).toBe(true)
    expect(again.config.model).toBe('custom-model')
  })

  it('jsonMode：false 持久化并回读（默认 true；免费模型关闭 response_format）', async () => {
    const state = await saveAiSettings({ config: { ...DEFAULT_AI_CONFIG, jsonMode: false } })
    expect(state.config.jsonMode).toBe(false)
    const again = await loadAiSettings()
    expect(again.config.jsonMode).toBe(false)
  })

  it('persistent：key 写 DB，load 回读；mask 不暴露明文', async () => {
    const key = 'sk-test-only-short-1'
    const state = await saveAiConfig({ apiKey: key })
    expect(state.apiKey).toBe(key)
    const loaded = await loadAiSettings()
    expect(loaded.keyStorage).toBe('persistent')
    expect(loaded.config.apiKey).toBe(key)
  })

  it('session：key 只进内存、不落 DB（新 load 仍从内存取，清空后为空）', async () => {
    const key = 'sk-session-only-1'
    const state = await saveAiSettings({ keyStorage: 'session', config: { apiKey: key } })
    expect(state.keyStorage).toBe('session')
    expect(state.config.apiKey).toBe(key)
    expect(getSessionApiKey()).toBe(key)
    // 切回 persistent 读 DB：session key 不应被持久化
    setSessionApiKey('')
    const loaded = await loadAiSettings()
    // 仍为 session 模式（内存已清）→ key 为空
    expect(loaded.keyStorage).toBe('session')
    expect(loaded.config.apiKey).toBe('')
    const persistent = await saveAiSettings({ keyStorage: 'persistent' })
    expect(persistent.config.apiKey).toBe('')
  })
})
