/**
 * LLM Provider（task-70）—— DeepSeek / OpenAI 兼容 Chat Completions。
 *
 * 只依赖注入的 `AiHttpClient`（transport 层），不直接碰 window/fetch，
 * 因此 CLI（arch task-73）与单测都能复用。
 * 安全：apiKey 只出现在 Authorization 头；错误对象/消息中绝不出现 key。
 */

import { AiNetworkError, AiTimeoutError, createAiHttpClient } from './transport'
import type { AiHttpClient } from './transport'
import type { AiConfig, AiErrorCode, AiProviderId, TokenUsage } from './types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatBody {
  messages: ChatMessage[]
  temperature?: number
  /** 请求严格 JSON 输出（OpenAI 兼容 response_format；DeepSeek 支持） */
  jsonMode?: boolean
}

export interface ChatResponse {
  text: string
  usage: TokenUsage
}

export interface LlmProvider {
  id: AiProviderId
  chat(body: ChatBody, cfg: AiConfig, signal: AbortSignal): Promise<ChatResponse>
}

/** provider 请求错误（带分类；message 已脱敏） */
export class AiRequestError extends Error {
  readonly code: AiErrorCode
  readonly status?: number
  readonly retryable: boolean

  constructor(code: AiErrorCode, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'AiRequestError'
    this.code = code
    this.status = opts.status
    this.retryable = opts.retryable ?? false
  }
}

/** 从敏感文本中剔除 key（错误摘要/日志用） */
export function sanitizeSnippet(text: string, secret?: string): string {
  let out = String(text ?? '')
  if (secret && secret.length >= 4) out = out.split(secret).join('[REDACTED]')
  // 兜底：形如 sk-xxxx 的 key 片段
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]')
  return out.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** 规范化 baseUrl：去重复斜杠、去尾部斜杠（保留协议） */
function normalizeBaseUrl(raw: string): string {
  const input = (raw || 'https://api.deepseek.com').trim()
  try {
    const u = new URL(input)
    u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
    return u.toString().replace(/\/+$/, '')
  } catch {
    return input.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  }
}

/**
 * OpenAI 兼容 endpoint 拼接（支持任意版本路径）：
 * - 已含 `/chat/completions` → 原样使用（只去尾部斜杠）；
 * - 路径以 `/v1`、`/v2`、`/v3`、`/v4` 等**任意版本段**结尾 → 追加 `/chat/completions`
 *   （deepseek /v1、qianfan /v2、火山 ark /api/v3、智谱 /api/paas/v4）；
 * - 其余 → 追加 `/v1/chat/completions`（deepseek/siliconflow 默认）。
 */
export function buildChatUrl(cfg: AiConfig): string {
  const base = normalizeBaseUrl(cfg.baseUrl)
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

/** HTTP 状态 → 错误分类 */
export function classifyHttpStatus(status: number): { code: AiErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'AI_AUTH', retryable: false }
  if (status === 402) return { code: 'AI_QUOTA', retryable: false }
  if (status === 408) return { code: 'AI_TIMEOUT', retryable: true }
  if (status === 429) return { code: 'AI_RATE_LIMIT', retryable: true }
  if (status >= 500) return { code: 'AI_NETWORK', retryable: true }
  return { code: 'AI_BAD_RESPONSE', retryable: false }
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeUsage(raw: unknown): TokenUsage {
  const usage = (raw ?? {}) as Record<string, unknown>
  const input = asNumber(usage.prompt_tokens)
  const output = asNumber(usage.completion_tokens)
  const total = asNumber(usage.total_tokens) || input + output
  return { input, output, total }
}

/** 解析 OpenAI 兼容响应体 */
export function parseChatResponse(json: unknown): ChatResponse {
  const data = (json ?? {}) as Record<string, unknown>
  const choices = data.choices as Array<Record<string, unknown>> | undefined
  const message = choices?.[0]?.message as Record<string, unknown> | undefined
  const text = typeof message?.content === 'string' ? message.content : ''
  if (!text.trim()) throw new AiRequestError('AI_BAD_RESPONSE', 'AI 返回空内容')
  const usage = normalizeUsage(data.usage)
  // 部分兼容端点不返回 usage：按文本粗估，保证成本上限仍可工作
  if (usage.total === 0) {
    usage.input = Math.ceil(JSON.stringify(data).length / 4)
    usage.output = Math.ceil(text.length / 4)
    usage.total = usage.input + usage.output
  }
  return { text, usage }
}

export interface CreateLlmProviderOptions {
  /** 注入 HTTP client（优先；测试/CLI 用） */
  http?: AiHttpClient
  /** 未注入 http 时用 fetch 构造 transport（测试 mock fetch 用） */
  fetchImpl?: typeof fetch
  /** 强制 transport（CLI 走 proxy 时用） */
  preferTransport?: 'proxy' | 'native'
}

/**
 * 创建 provider。注意：`chat()` 每次调用按传入 cfg 选择/构造 HTTP client；
 * 若 create 时注入了 http 则优先使用注入的 client（测试）。
 */
export function createLlmProvider(opts: CreateLlmProviderOptions = {}): LlmProvider {
  const injectedHttp = opts.http
  return {
    id: 'deepseek',
    async chat(body, cfg, signal) {
      if (!cfg.apiKey) throw new AiRequestError('AI_NO_KEY', '未配置 AI API Key')
      const http =
        injectedHttp ??
        (opts.preferTransport === 'proxy'
          ? createAiHttpClient({ ...cfg, transport: 'proxy' }, { fetchImpl: opts.fetchImpl })
          : createAiHttpClient(cfg, { fetchImpl: opts.fetchImpl }))
      const payload: Record<string, unknown> = {
        model: cfg.model,
        messages: body.messages,
        temperature: body.temperature ?? cfg.temperature ?? 0.3,
        stream: false,
      }
      // jsonMode 优先级：显式 body 参数 > cfg.jsonMode > 默认 true（部分免费模型不支持时关掉）
      const useJsonMode = body.jsonMode ?? cfg.jsonMode ?? true
      if (useJsonMode !== false) payload.response_format = { type: 'json_object' }

      let res
      try {
        res = await http.send({
          url: buildChatUrl(cfg),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(payload),
          timeoutMs: cfg.timeoutMs ?? 60_000,
          signal,
        })
      } catch (error) {
        if (error instanceof AiTimeoutError) {
          throw new AiRequestError('AI_TIMEOUT', 'AI 请求超时', { retryable: true })
        }
        if ((error as Error | null)?.name === 'AbortError') {
          throw new AiRequestError('AI_CANCELED', '已取消')
        }
        if (error instanceof AiNetworkError) {
          const detail = error.message && error.message !== 'AI network error' ? `：${error.message}` : ''
          throw new AiRequestError('AI_NETWORK', `AI 网络请求失败${detail}`, { retryable: true })
        }
        throw new AiRequestError('AI_UNKNOWN', 'AI 请求失败')
      }

      if (res.status < 200 || res.status >= 300) {
        const info = classifyHttpStatus(res.status)
        const base =
          info.code === 'AI_AUTH'
            ? 'AI 鉴权失败（请检查 Key）'
            : info.code === 'AI_QUOTA'
              ? 'AI 配额/余额不足'
              : info.code === 'AI_RATE_LIMIT'
                ? 'AI 接口限流，请稍后重试'
                : `AI 接口返回错误（HTTP ${res.status}）`
        const bodySnippet = sanitizeSnippet(String(res.text ?? '').slice(0, 200), cfg.apiKey).trim()
        throw new AiRequestError(
          info.code,
          bodySnippet ? `${base}：${bodySnippet}` : base,
          { status: res.status, retryable: info.retryable },
        )
      }

      let json: unknown
      try {
        json = JSON.parse(res.text)
      } catch {
        throw new AiRequestError('AI_BAD_RESPONSE', 'AI 响应不是合法 JSON', { status: res.status })
      }
      try {
        return parseChatResponse(json)
      } catch (error) {
        if (error instanceof AiRequestError) throw error
        throw new AiRequestError('AI_BAD_RESPONSE', 'AI 响应结构异常', { status: res.status })
      }
    },
  }
}
