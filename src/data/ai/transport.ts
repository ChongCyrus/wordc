/**
 * AI 传输层（task-70；对应 ARCH-CONTENT-PACKS §5）。
 *
 * - 浏览器/PWA：`proxy` —— 请求发到本地代理（`tools/ai-proxy.mjs`，127.0.0.1:8788），
 *   由代理转发到 DeepSeek/OpenAI 兼容端点（补 CORS，防 SSRF）。
 * - APK：`native` —— `window.AiApi` 原生桥（arch task-72 实现；host 白名单默认 api.deepseek.com）。
 * - 测试/CLI：注入 `fetchImpl` 或自定义 `AiHttpClient`。
 *
 * 安全：Authorization 头只在内存中转发；错误信息不含 key/headers。
 */

import type { AiConfig, AiTransport } from './types'

/** 本地代理默认地址（浏览器 transport=proxy） */
export const AI_PROXY_DEFAULT_URL = 'http://127.0.0.1:8788'

/** 默认超时 60s（ARCH §5） */
export const AI_DEFAULT_TIMEOUT_MS = 60_000

/** 响应体上限 4MB（ARCH §5） */
export const AI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface AiHttpRequest {
  /** provider 的完整 URL（如 https://api.deepseek.com/v1/chat/completions） */
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface AiHttpResponse {
  status: number
  text: string
}

export interface AiHttpClient {
  send(req: AiHttpRequest): Promise<AiHttpResponse>
}

/** 原生侧回调结果（arch task-72 契约） */
export interface AiApiBridgeResult {
  ok: boolean
  status?: number
  body?: string
  error?: string
}

export interface AiApiBridge {
  isNativeApp?: () => string
  request?: (
    requestId: string,
    method: string,
    url: string,
    headersJson: string,
    body: string,
  ) => void
  cancel?: (requestId: string) => void
}

declare global {
  interface Window {
    AiApi?: AiApiBridge
    /** 原生侧异步回调：requestId 对应；result 可能是 JSON 字符串 */
    __aiApiCallback?: (requestId: string, result: AiApiBridgeResult | string) => void
  }
}

/** 原生桥是否可用（APK 内 arch 注入） */
export function isNativeAiAvailable(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = window.AiApi
  return Boolean(bridge && typeof bridge.request === 'function')
}

/** 实际使用哪种 transport（auto：原生桥可用则 native，否则 proxy） */
export function resolveTransport(cfg: AiConfig): 'proxy' | 'native' {
  const t: AiTransport = cfg.transport ?? 'auto'
  if (t === 'native') return 'native'
  if (t === 'proxy') return 'proxy'
  return isNativeAiAvailable() ? 'native' : 'proxy'
}

/** 超时错误（不包含 key） */
export class AiTimeoutError extends Error {
  constructor() {
    super(`AI request timed out`)
    this.name = 'AiTimeoutError'
  }
}

/** 网络错误（不包含 key） */
export class AiNetworkError extends Error {
  constructor(message = 'AI network error') {
    super(message)
    this.name = 'AiNetworkError'
  }
}

/** 组合外部 signal + 超时 signal（Node 20+/现代浏览器支持 AbortSignal.any） */
function combineSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new AiTimeoutError()), Math.max(1, timeoutMs))
  const onAbort = () => controller.abort(external?.reason)
  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    },
  }
}

function isTimeout(error: unknown): boolean {
  if (error instanceof AiTimeoutError) return true
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as Error).name === 'AbortError' && false)
}

/** 用注入的 fetch 实现（浏览器/CLI/测试） */
export function createFetchHttpClient(fetchImpl: typeof fetch = globalThis.fetch): AiHttpClient {
  return {
    async send(req) {
      const { signal, cleanup } = combineSignals(req.timeoutMs, req.signal)
      try {
        const res = await fetchImpl(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal,
          redirect: 'error',
        })
        const text = await res.text()
        if (text.length > AI_MAX_RESPONSE_BYTES) {
          throw new AiNetworkError('AI response too large')
        }
        return { status: res.status, text }
      } catch (error) {
        if (isTimeout(error) || (error as Error | null)?.name === 'TimeoutError') {
          throw new AiTimeoutError()
        }
        if ((error as Error | null)?.name === 'AbortError') {
          if (signal.reason instanceof AiTimeoutError) throw new AiTimeoutError()
          throw error
        }
        throw new AiNetworkError('AI network error')
      } finally {
        cleanup()
      }
    },
  }
}

/** 原生桥回调参数归一（宿主可能传对象或 JSON 字符串） */
function normalizeBridgeResult(raw: AiApiBridgeResult | string | null | undefined): AiApiBridgeResult {
  if (raw == null) return { ok: false, error: 'empty native response' }
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: false, error: 'empty native response' }
    try {
      return (JSON.parse(raw) as AiApiBridgeResult) ?? { ok: false, error: 'empty native response' }
    } catch {
      return { ok: false, error: 'invalid native response' }
    }
  }
  return raw
}

let sequence = 0
function nextRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return `ai-${cryptoApi.randomUUID()}`
  sequence += 1
  return `ai-${Date.now().toString(36)}-${sequence.toString(36)}`
}

/** 原生桥 HTTP client（APK）；回调 → Promise<Response> */
export function createNativeHttpClient(timeoutMs = AI_DEFAULT_TIMEOUT_MS): AiHttpClient {
  return {
    async send(req) {
      const bridge = typeof window !== 'undefined' ? window.AiApi : undefined
      if (!bridge || typeof bridge.request !== 'function') {
        throw new AiNetworkError('AI native bridge unavailable')
      }
      const requestId = nextRequestId()
      const request = bridge.request.bind(bridge)
      return new Promise<AiHttpResponse>((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (req.signal) req.signal.removeEventListener('abort', onAbort)
          if (prevCallback) window.__aiApiCallback = prevCallback
          fn()
        }
        const timer = setTimeout(() => {
          bridge.cancel?.(requestId)
          finish(() => reject(new AiTimeoutError()))
        }, Math.max(1, req.timeoutMs || timeoutMs))
        const onAbort = () => {
          bridge.cancel?.(requestId)
          finish(() => reject(new DOMException('Aborted', 'AbortError')))
        }
        if (req.signal) {
          if (req.signal.aborted) {
            finish(() => reject(new DOMException('Aborted', 'AbortError')))
            return
          }
          req.signal.addEventListener('abort', onAbort, { once: true })
        }
        /** 串行回调（一次只有一个在途请求；连续生成用并发 3 时通过 requestId 分发） */
        const pending = (result: AiApiBridgeResult | string) => {
          const normalized = normalizeBridgeResult(result)
          finish(() => {
            if (!normalized.ok) {
              reject(new AiNetworkError(normalized.error || 'AI native request failed'))
              return
            }
            resolve({ status: normalized.status ?? 200, text: normalized.body ?? '' })
          })
        }
        const prevCallback = window.__aiApiCallback
        window.__aiApiCallback = (id: string, result: AiApiBridgeResult | string) => {
          if (id === requestId) {
            pending(result)
            return
          }
          prevCallback?.(id, result)
        }
        try {
          request(requestId, req.method, req.url, JSON.stringify(req.headers), req.body)
        } catch {
          finish(() => reject(new AiNetworkError('AI native request failed')))
        }
      })
    },
  }
}

/** 浏览器本地代理 client：把 provider URL 的 path 转发到代理地址 */
export function createProxyHttpClient(opts: {
  proxyUrl?: string
  fetchImpl?: typeof fetch
} = {}): AiHttpClient {
  const base = (opts.proxyUrl ?? AI_PROXY_DEFAULT_URL).replace(/\/+$/, '')
  const fetchClient = createFetchHttpClient(opts.fetchImpl)
  return {
    send(req) {
      let path = '/v1/chat/completions'
      try {
        path = new URL(req.url).pathname
      } catch {
        // 保留默认 path
      }
      return fetchClient.send({ ...req, url: `${base}${path}` })
    },
  }
}

/** 根据配置选择 HTTP client（transport=auto/proxy/native） */
export function createAiHttpClient(cfg: AiConfig, opts: { fetchImpl?: typeof fetch } = {}): AiHttpClient {
  const mode = resolveTransport(cfg)
  if (mode === 'native') return createNativeHttpClient(cfg.timeoutMs ?? AI_DEFAULT_TIMEOUT_MS)
  return createProxyHttpClient({ proxyUrl: cfg.proxyUrl, fetchImpl: opts.fetchImpl })
}
