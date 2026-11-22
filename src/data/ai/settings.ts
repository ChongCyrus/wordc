/**
 * AI 设置读写（task-70；settings keys 见 docs/ARCH-CONTENT-PACKS.md §7）。
 *
 * ⚠️ `ai.apiKey` 是敏感字段：
 * - 只存本机 settings（或 session 内存态，`ai.keyStorage='session'` 时不落 DB）；
 * - 掩码显示用 `maskApiKey`；导出/日志/错误用 `redactAiConfig` / 不含 key 的值；
 * - 本模块的任何返回值/错误都不主动打印 key。
 */

import { getSettings, updateSettings } from '../settings.repo'
import type { AiConfig, AiProviderId, AiTransport } from './types'
import { AI_PROXY_DEFAULT_URL } from './transport'

export const AI_SETTING_KEYS = [
  'ai.enabled',
  'ai.provider',
  'ai.baseUrl',
  'ai.model',
  'ai.apiKey',
  'ai.keyStorage',
  'ai.transport',
  'ai.batchSize',
  'ai.maxCostPerRun',
  'ai.pregenBudget',
] as const

/** 默认配置（与 settings 默认值保持一致；settings 缺省时兜底） */
export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  transport: 'auto',
  batchSize: 20,
  maxCostPerRun: 3,
  temperature: 0.3,
  timeoutMs: 60_000,
  proxyUrl: AI_PROXY_DEFAULT_URL,
  jsonMode: true,
}

/** AI 开关 + 预算（generate 不关心，但 UI/CLI 需要） */
export interface AiSettingsState {
  config: AiConfig
  enabled: boolean
  keyStorage: 'persistent' | 'session'
  pregenBudget: number
}

/** session 模式下的内存 key（刷新/重启失效） */
let sessionApiKey = ''

export function setSessionApiKey(key: string): void {
  sessionApiKey = key
}

export function getSessionApiKey(): string {
  return sessionApiKey
}

/** 掩码：任何情况下都不返回完整 key（长度 ≤8 只显示圆点） */
export function maskApiKey(key: string): string {
  const k = (key ?? '').trim()
  if (!k) return ''
  if (k.length <= 8) return '••••••'
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

/** 可安全用于日志/导出的配置副本（apiKey 掩码/清空） */
export function redactAiConfig(cfg: AiConfig): AiConfig {
  return { ...cfg, apiKey: maskApiKey(cfg.apiKey) }
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 读取 AI 设置（缺省 key 用 DEFAULT_AI_CONFIG 兜底，老库/未迁移时不崩） */
export async function loadAiSettings(): Promise<AiSettingsState> {
  let s: Record<string, unknown> = {}
  try {
    s = (await getSettings()) as unknown as Record<string, unknown>
  } catch {
    s = {}
  }
  const keyStorage = pickEnum(s['ai.keyStorage'], ['persistent', 'session'] as const, 'persistent')
  const persistedKey = typeof s['ai.apiKey'] === 'string' ? (s['ai.apiKey'] as string) : ''
  const config: AiConfig = {
    provider: pickEnum<AiProviderId>(s['ai.provider'], ['deepseek', 'openai-compatible'], 'deepseek'),
    baseUrl:
      typeof s['ai.baseUrl'] === 'string' && (s['ai.baseUrl'] as string).trim()
        ? (s['ai.baseUrl'] as string).trim()
        : DEFAULT_AI_CONFIG.baseUrl,
    model:
      typeof s['ai.model'] === 'string' && (s['ai.model'] as string).trim()
        ? (s['ai.model'] as string).trim()
        : DEFAULT_AI_CONFIG.model,
    apiKey: keyStorage === 'session' ? sessionApiKey : persistedKey,
    transport: pickEnum<AiTransport>(s['ai.transport'], ['auto', 'proxy', 'native'], 'auto'),
    batchSize: Math.floor(pickNumber(s['ai.batchSize'], 20, 1, 50)),
    maxCostPerRun: pickNumber(s['ai.maxCostPerRun'], 3, 0, 1000),
    temperature: 0.3,
    timeoutMs: 60_000,
    proxyUrl: AI_PROXY_DEFAULT_URL,
    jsonMode: s['ai.jsonMode'] !== false, // 默认 true；显式 false 才关闭
  }
  return {
    config,
    enabled: s['ai.enabled'] === true,
    keyStorage,
    pregenBudget: pickNumber(s['ai.pregenBudget'], 40, 0, 10_000),
  }
}

/** 只取 provider 配置（generate 用） */
export async function loadAiConfig(): Promise<AiConfig> {
  return (await loadAiSettings()).config
}

export interface SaveAiConfigOptions {
  /** 不传则沿用当前 keyStorage */
  keyStorage?: 'persistent' | 'session'
}

/** 保存 AI 配置（仅 provider 配置；enabled/pregenBudget 用 saveAiSettings） */
export async function saveAiConfig(patch: Partial<AiConfig>, opts: SaveAiConfigOptions = {}): Promise<AiConfig> {
  const state = await saveAiSettings({ config: patch, ...(opts.keyStorage ? { keyStorage: opts.keyStorage } : {}) })
  return state.config
}

export interface SaveAiSettingsOptions {
  /** provider 配置（baseUrl/model/apiKey/transport/batchSize/maxCostPerRun...） */
  config?: Partial<AiConfig>
  /** 总开关（ai.enabled） */
  enabled?: boolean
  /** 全量预生成预算（元；ai.pregenBudget） */
  pregenBudget?: number
  /** Key 存储方式（persistent=存 DB；session=仅内存、刷新失效） */
  keyStorage?: 'persistent' | 'session'
}

/**
 * 保存 AI 设置（覆盖设置页全部字段）。
 * - `ai.apiKey`：session 模式只进内存、不写 DB；persistent 模式写 settings（导出时由 data 层过滤）；
 * - 设置校验失败（如越界）由 data 层 throw；本函数不吞 UI 需要的错误？——统一 resolve 返回最新状态，
 *   写失败时返回原状态（UI 可对比期望值提示「设置未保存」）。
 */
export async function saveAiSettings(patch: SaveAiSettingsOptions): Promise<AiSettingsState> {
  const current = await loadAiSettings()
  const keyStorage = patch.keyStorage ?? current.keyStorage
  const next: Record<string, unknown> = {}
  if (patch.enabled != null) next['ai.enabled'] = patch.enabled === true
  if (patch.pregenBudget != null) next['ai.pregenBudget'] = patch.pregenBudget
  if (patch.keyStorage != null) next['ai.keyStorage'] = keyStorage

  const cfg = patch.config
  if (cfg) {
    if (cfg.provider != null) next['ai.provider'] = cfg.provider
    if (cfg.baseUrl != null) next['ai.baseUrl'] = cfg.baseUrl
    if (cfg.model != null) next['ai.model'] = cfg.model
    if (cfg.transport != null) next['ai.transport'] = cfg.transport
    if (cfg.batchSize != null) next['ai.batchSize'] = cfg.batchSize
    if (cfg.maxCostPerRun != null) next['ai.maxCostPerRun'] = cfg.maxCostPerRun
    if (cfg.jsonMode != null) next['ai.jsonMode'] = cfg.jsonMode
    if (cfg.apiKey != null) {
      if (keyStorage === 'session') {
        setSessionApiKey(cfg.apiKey)
        next['ai.apiKey'] = '' // 不落 DB
      } else {
        next['ai.apiKey'] = cfg.apiKey
        setSessionApiKey('')
      }
    }
  }

  try {
    if (Object.keys(next).length > 0) await updateSettings(next as never)
  } catch {
    // 校验失败不崩溃；返回最新可读状态，UI 对比期望值提示
  }
  return loadAiSettings()
}

/** 清除 Key（内存 + DB 两处） */
export async function clearAiApiKey(): Promise<void> {
  setSessionApiKey('')
  try {
    await updateSettings({ 'ai.apiKey': '' } as never)
  } catch {
    // ignore
  }
}
