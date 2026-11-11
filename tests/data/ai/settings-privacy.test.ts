import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AI_CONFIG,
  getSessionApiKey,
  loadAiSettings,
  maskApiKey,
  redactAiConfig,
  setSessionApiKey,
} from '../../../src/data/ai'

const KEY = 'sk-short-secret-123'

describe('ai/settings · 隐私（key 掩码/导出脱敏）', () => {
  it('maskApiKey：不返回完整 key（空/短/长三种）', () => {
    expect(maskApiKey('')).toBe('')
    expect(maskApiKey('short')).toBe('••••••')
    const masked = maskApiKey(KEY)
    expect(masked).not.toBe(KEY)
    expect(masked).not.toContain(KEY)
    expect(masked).toContain('…')
    expect(masked).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/)
  })

  it('redactAiConfig：可安全交付给日志/导出的副本不含 key', () => {
    const redacted = redactAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: KEY })
    expect(JSON.stringify(redacted)).not.toContain(KEY)
    expect(redacted.apiKey).toBe(maskApiKey(KEY))
    expect(redacted.model).toBe(DEFAULT_AI_CONFIG.model)
  })

  it('默认配置符合 ARCH：deepseek / deepseek-chat / batchSize 20 / maxCost 3 / auto', () => {
    expect(DEFAULT_AI_CONFIG.provider).toBe('deepseek')
    expect(DEFAULT_AI_CONFIG.baseUrl).toBe('https://api.deepseek.com')
    expect(DEFAULT_AI_CONFIG.model).toBe('deepseek-chat')
    expect(DEFAULT_AI_CONFIG.batchSize).toBe(20)
    expect(DEFAULT_AI_CONFIG.maxCostPerRun).toBe(3)
    expect(DEFAULT_AI_CONFIG.transport).toBe('auto')
    expect(DEFAULT_AI_CONFIG.jsonMode).toBe(true)
    expect(DEFAULT_AI_CONFIG.apiKey).toBe('')
  })

  it('session key 只进内存（set/get），不参与导出上下文', () => {
    setSessionApiKey(KEY)
    expect(getSessionApiKey()).toBe(KEY)
    expect(JSON.stringify({ config: redactAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: getSessionApiKey() }) })).not.toContain(KEY)
    setSessionApiKey('')
    expect(getSessionApiKey()).toBe('')
  })

  it('loadAiSettings 在无 settings 后端时回退默认值、不抛错（老库/首启安全）', async () => {
    const state = await loadAiSettings()
    expect(state.enabled).toBe(false)
    expect(state.keyStorage).toBe('persistent')
    expect(state.pregenBudget).toBe(40)
    expect(state.config.provider).toBe('deepseek')
    expect(state.config.batchSize).toBe(20)
    expect(state.config.maxCostPerRun).toBe(3)
    expect(state.config.jsonMode).toBe(true)
  })
})
