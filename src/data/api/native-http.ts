/**
 * APK 原生 HTTP 桥（task-38 / task-37 协议）。
 *
 * APK 壳（arch 实现）在 WebView 注入：
 * - `window.MomoApi.isNativeApp()` → `'momo-apk'`
 * - `window.MomoApi.request(requestId, method, url, headersJson, body)`
 *   → 异步调用 `window.__momoApiCallback(requestId, resultJson)`
 *   - 成功：`{ ok: true, status: 200, body: '<响应文本>' }`
 *   - 失败：`{ ok: false, error: '...' }`
 * - host 白名单：`open.maimemo.com`（原生侧校验；本包装只做转发）。
 *
 * 浏览器/PWA 没有该桥 → `isNativeHttpAvailable() === false`，仍走原有 fetch + 本地代理。
 * 这里把回调式桥接包装成标准 `fetch(url, init) => Promise<Response>`，失败统一抛 `TypeError`
 * （`maimemo-client` 的分类逻辑会把 TypeError 归到 E_NETWORK/E_TIMEOUT，不会出现 CORS/代理提示）。
 */

/** 原生桥回调结果（原生 → JS） */
export interface MomoApiBridgeResult {
  ok: boolean
  status?: number
  /** 响应文本（JSON 字符串） */
  body?: string
  error?: string
}

/** WebView 注入的原生桥 */
export interface MomoApiBridge {
  isNativeApp?: () => string
  request?: (
    requestId: string,
    method: string,
    url: string,
    headersJson: string,
    body: string,
  ) => void
  /** 取消在途请求（页面卸载/会话结束时用；可选） */
  cancel?: (requestId: string) => void
}

declare global {
  interface Window {
    MomoApi?: MomoApiBridge
    /** 原生侧调用：一次性/异步回调（requestId 对应；result 可能是 JSON 字符串） */
    __momoApiCallback?: (requestId: string, result: MomoApiBridgeResult | string) => void
  }
}

/** 默认超时（与原生桥约定一致：25s） */
export const NATIVE_HTTP_TIMEOUT_MS = 25_000

let sequence = 0

/** 原生回调参数归一：宿主可能传对象，也可能传 JSON 字符串（arch 契约） */
function normalizeBridgeResult(raw: MomoApiBridgeResult | string | null | undefined): MomoApiBridgeResult {
  if (raw == null) return { ok: false, error: 'empty native response' }
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: false, error: 'empty native response' }
    try {
      const parsed = JSON.parse(raw) as MomoApiBridgeResult
      return parsed ?? { ok: false, error: 'empty native response' }
    } catch {
      return { ok: false, error: `invalid native response: ${raw.slice(0, 120)}` }
    }
  }
  return raw
}

/** 生成本次请求的唯一 id（crypto.randomUUID 优先，兜底时间戳+序号+随机） */
function nextRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `momo-${cryptoApi.randomUUID()}`
  }
  sequence += 1
  return `momo-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function getNativeBridge(): MomoApiBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = window.MomoApi
  if (!bridge || typeof bridge.request !== 'function') return null
  return bridge
}

/**
 * 原生 HTTP 桥是否可用。
 * 协议：`window.MomoApi.isNativeApp?.() === 'momo-apk'`；若宿主没提供 isNativeApp 但 request 存在，
 * 视为可用（兼容早期 APK 壳）。
 */
export function isNativeHttpAvailable(): boolean {
  const bridge = getNativeBridge()
  if (!bridge) return false
  if (typeof bridge.isNativeApp === 'function') {
    try {
      return bridge.isNativeApp() === 'momo-apk'
    } catch {
      return false
    }
  }
  return true
}

type PendingResolver = (result: MomoApiBridgeResult) => void

const pending = new Map<string, PendingResolver>()
/** requestId → 取消函数（超时/卸载时清理原生在途请求） */
const cancellers = new Map<string, () => void>()
let unloadHooked = false

/** 取消所有在途原生请求（页面卸载/会话结束时调用；幂等） */
export function cancelAllNativeRequests(): void {
  for (const [, reject] of pending) {
    reject({ ok: false, error: 'native http cancelled' })
  }
  pending.clear()
  for (const [, cancel] of cancellers) {
    try {
      cancel()
    } catch {
      // 忽略原生侧取消失败
    }
  }
  cancellers.clear()
}

function ensureUnloadHook(): void {
  if (unloadHooked || typeof window === 'undefined') return
  if (typeof window.addEventListener !== 'function') return
  window.addEventListener('beforeunload', () => cancelAllNativeRequests())
  unloadHooked = true
}

/** 安装（幂等）全局回调分发器：把原生回调按 requestId 路由到对应 Promise */
function ensureCallbackInstalled(): void {
  if (typeof window === 'undefined') return
  if (!window.__momoApiCallback) {
    window.__momoApiCallback = (requestId: string, result: MomoApiBridgeResult | string): void => {
      const resolver = pending.get(requestId)
      if (!resolver) return
      pending.delete(requestId)
      resolver(normalizeBridgeResult(result))
    }
    return
  }
  // 已被别处安装（例如宿主自带 dispatcher）：包一层，仍按 requestId 分发
  if (!(window as unknown as { __momoApiCallbackPatched?: boolean }).__momoApiCallbackPatched) {
    const previous = window.__momoApiCallback
    window.__momoApiCallback = (requestId: string, result: MomoApiBridgeResult | string): void => {
      const resolver = pending.get(requestId)
      if (resolver) {
        pending.delete(requestId)
        resolver(normalizeBridgeResult(result))
        return
      }
      previous?.(requestId, result)
    }
    ;(window as unknown as { __momoApiCallbackPatched?: boolean }).__momoApiCallbackPatched = true
  }
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value
    return out
  }
  return { ...(headers as Record<string, string>) }
}

function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return ''
  if (typeof body === 'string') return body
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString()
  return String(body)
}

/**
 * 原生桥版 fetch：`nativeFetch(url, init) => Promise<Response>`。
 *
 * - URL 必须是绝对地址（`https://open.maimemo.com/...`），原生侧按 host 白名单校验；
 * - 失败/超时抛 `TypeError`（name 保持 TypeError；message 含 timeout 便于上层归到 E_TIMEOUT）；
 * - `init.signal` 中止 → 抛 AbortError 同义错误。
 */
export function nativeFetch(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  const bridge = getNativeBridge()
  const requestFn = bridge?.request
  if (!bridge || typeof requestFn !== 'function') {
    return Promise.reject(new TypeError('native http bridge not available'))
  }
  const requestId = nextRequestId()
  const timeoutMs = Math.max(1, opts.timeoutMs ?? NATIVE_HTTP_TIMEOUT_MS)
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = headersToRecord(init.headers)
  const body = bodyToString(init.body)

  ensureCallbackInstalled()
  ensureUnloadHook()

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      pending.delete(requestId)
      cancellers.delete(requestId)
      clearTimeout(timer)
    }
    const finish = (result: MomoApiBridgeResult): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!result || result.ok !== true) {
        reject(new TypeError(`native http request failed: ${result?.error ?? 'unknown error'}`))
        return
      }
      const status = Number.isFinite(result.status) ? Number(result.status) : 200
      try {
        resolve(
          new Response(result.body ?? '', {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        )
      } catch (error) {
        reject(new TypeError(`native http invalid response: ${String(error)}`))
      }
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new TypeError('native http request timeout'))
    }, timeoutMs)

    pending.set(requestId, finish)
    if (typeof bridge.cancel === 'function') {
      cancellers.set(requestId, () => bridge.cancel?.(requestId))
    }

    const signal = init.signal
    if (signal) {
      if (signal.aborted) {
        settled = true
        cleanup()
        reject(new TypeError('native http request aborted'))
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new TypeError('native http request aborted'))
        },
        { once: true },
      )
    }

    try {
      requestFn.call(bridge, requestId, method, url, JSON.stringify(headers), body)
    } catch (error) {
      if (!settled) {
        settled = true
        cleanup()
        reject(new TypeError(`native http request error: ${String(error)}`))
      }
    }
  })
}
