/**
 * APK 原生 AI 桥（task-72）辅助：bridge 检测 + 自定义 host 安全校验/授权。
 *
 * 原生协议（MainActivity.AiApiBridge）：
 * - window.AiApi.request(requestId, method, url, headersJson, body) → window.__aiApiCallback
 * - window.AiApi.addHost(host, requestId) → 原生确认框 → window.__aiApiHostResult(requestId, 'ok'|'denied'|'invalid')
 * - 原生 allowlist 默认 api.deepseek.com；自定义 host 需用户在原生对话框确认后才持久化。
 *
 * 安全：仅 https；拒绝 localhost/私网/裸 IP/userinfo/端口；Key 只在请求头中经内存传递，原生不落日志。
 */
import type { AiApiBridge } from './transport'

export { createNativeHttpClient, isNativeAiAvailable } from './transport'

export type AiHostPermission = 'ok' | 'denied' | 'invalid' | 'unsupported' | 'timeout'

interface HostDialogBridge extends AiApiBridge {
  addHost?: (host: string, requestId: string) => void
}

declare global {
  interface Window {
    __aiApiHostResult?: (requestId: string, result: string) => void
  }
}

/** 校验自定义 AI host（只接受域名；https 由协议固定；拒绝私网/裸 IP/localhost） */
export function validateCustomAiHost(raw: string): { ok: boolean; host?: string; reason?: string } {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return { ok: false, reason: 'host 不能为空' }
  if (value.includes('://') || value.includes('/') || value.includes('@') || value.includes(':')) {
    return { ok: false, reason: '只填域名（不要带协议/路径/端口）' }
  }
  const host = value.endsWith('.') ? value.slice(0, -1) : value
  if (!host.includes('.') || host.length > 253) return { ok: false, reason: '域名格式不正确' }
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: '域名只能包含字母/数字/点/短横线' }
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: '不允许 localhost' }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return { ok: false, reason: '不允许裸 IP' }
  return { ok: true, host }
}

/** 请求原生确认添加 host（APK 外返回 unsupported；超时 60s） */
export function requestAiHostPermission(host: string, timeoutMs = 60_000): Promise<AiHostPermission> {
  if (typeof window === 'undefined') return Promise.resolve('unsupported')
  const bridge = window.AiApi as HostDialogBridge | undefined
  if (!bridge || typeof bridge.addHost !== 'function') return Promise.resolve('unsupported')
  const requestId = `aihost-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise<AiHostPermission>((resolve) => {
    let settled = false
    const finish = (value: AiHostPermission) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (prev) window.__aiApiHostResult = prev
      resolve(value)
    }
    const timer = setTimeout(() => finish('timeout'), Math.max(1, timeoutMs))
    const prev = window.__aiApiHostResult
    window.__aiApiHostResult = (id, result) => {
      if (id !== requestId) {
        prev?.(id, result)
        return
      }
      finish(result === 'ok' || result === 'denied' || result === 'invalid' ? result : 'invalid')
    }
    try {
      bridge.addHost!(host, requestId)
    } catch {
      finish('invalid')
    }
  })
}
