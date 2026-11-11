import { afterEach, describe, expect, it } from 'vitest'
import {
  createMaimemoAbortHandle,
  DEFAULT_PROXY_URL,
  describeMaimemoFailure,
  formatMaimemoScanProgress,
  formatMaimemoSummary,
  isMaimemoCancelled,
  resolveMaimemoTransport,
} from '../../src/app/hooks/useMaimemoTransport'

// 注：原生桥检测的单一来源是 data.isNativeHttpAvailable()（task-38）；
// 本文件只验证 UI 的两种模式展示逻辑（nativeAvailable 由页面从 data 读入）。

const globals = globalThis as unknown as { window?: unknown; MomoApi?: unknown }

afterEach(() => {
  delete globals.window
})

describe('墨墨导入模式解析（task-39）', () => {
  it('APK 原生可用：内置直连、隐藏代理输入、隐私文案', () => {
    const view = resolveMaimemoTransport({ nativeAvailable: true, proxyUrl: DEFAULT_PROXY_URL })
    expect(view.transport).toBe('native')
    expect(view.showProxyInput).toBe(false)
    expect(view.canImport).toBe(true)
    expect(view.modeLabel).toContain('内置直连')
    expect(view.modeDescription).toContain('内置网络直连')
    expect(view.privacyText).toContain('只写本机')
  })

  it('浏览器/PWA：显示代理输入 + 启动代理说明', () => {
    const view = resolveMaimemoTransport({
      nativeAvailable: false,
      proxyUrl: DEFAULT_PROXY_URL,
    })
    expect(view.transport).toBe('proxy')
    expect(view.showProxyInput).toBe(true)
    expect(view.canImport).toBe(true)
    expect(view.proxyHint).toContain('maimemo-proxy.mjs')
    expect(view.missingProxyMessage).toBeNull()
  })

  it('PWA 未填代理：不可导入 + 明确提示（CORS/代理）', () => {
    const view = resolveMaimemoTransport({ nativeAvailable: false, proxyUrl: '   ' })
    expect(view.canImport).toBe(false)
    expect(view.showProxyInput).toBe(true)
    expect(view.missingProxyMessage).toContain('未填写代理地址')
    expect(view.missingProxyMessage).toContain('maimemo-proxy.mjs')
  })

  it('data 的 isNativeHttpAvailable=false（SSR/浏览器）时 UI 走代理模式', () => {
    const view = resolveMaimemoTransport({ nativeAvailable: false, proxyUrl: '' })
    expect(view.transport).toBe('proxy')
    expect(view.showProxyInput).toBe(true)
  })
})

describe('墨墨导入错误映射（原生不再提示 CORS）', () => {
  it('原生模式：CORS/网络错误改为「网络失败或 Token 失效」', () => {
    const cors = describeMaimemoFailure({ code: 'E_CORS' }, 'native')
    expect(cors).toContain('网络失败或 Token 失效')
    expect(cors.toLowerCase()).not.toContain('cors')
    expect(cors).not.toContain('代理')

    const network = describeMaimemoFailure({ code: 'E_NETWORK' }, 'native')
    expect(network).toContain('网络失败或 Token 失效')
    expect(network).not.toContain('代理')
  })

  it('代理模式：CORS 提示运行 proxy 脚本；网络失败提示检查代理', () => {
    const cors = describeMaimemoFailure({ code: 'E_CORS' }, 'proxy')
    expect(cors).toContain('maimemo-proxy.mjs')
    expect(cors).toContain('代理地址')
    const network = describeMaimemoFailure({ code: 'E_NETWORK' }, 'proxy')
    expect(network).toContain('代理')
  })

  it('Token 类错误：两种模式都给重新获取 Token 的提示', () => {
    for (const transport of ['native', 'proxy'] as const) {
      expect(describeMaimemoFailure({ code: 'E_NO_TOKEN' }, transport)).toContain('Token')
      expect(describeMaimemoFailure({ code: 'E_UNAUTHORIZED' }, transport)).toContain('重新获取')
      expect(describeMaimemoFailure({ code: 'E_RATE_LIMITED' }, transport)).toContain('过于频繁')
    }
  })

  it('优先使用 data.maimemoMessageFor(code) 的环境文案（原生不出现代理/CORS）', () => {
    const nativeLookup = (code: string) =>
      code === 'E_NETWORK' || code === 'E_CORS'
        ? { title: '网络失败', hint: '请检查网络连接或墨墨 Token（APK 内置直连，无需额外设置）' }
        : undefined
    for (const code of ['E_NETWORK', 'E_CORS']) {
      const message = describeMaimemoFailure({ code }, 'native', nativeLookup)
      expect(message).toContain('网络失败')
      expect(message).not.toContain('代理')
      expect(message.toLowerCase()).not.toContain('cors')
    }
    const auth = describeMaimemoFailure({ code: 'E_UNAUTHORIZED' }, 'native', nativeLookup)
    expect(auth).toContain('重新获取')
  })

  it('未知错误：原生模式兜底文案含「检查网络或 Token」', () => {
    expect(describeMaimemoFailure({ message: 'x' }, 'native')).toContain('检查网络或 Token')
    expect(describeMaimemoFailure({ message: 'boom' }, 'proxy')).toContain('boom')
  })
})

describe('墨墨导入新进度语义（task-40/41：已扫描词数/总词数）', () => {
  it('扫描进度：X/Y + 百分比（不显示成已导入记录数）', () => {
    expect(formatMaimemoScanProgress(1250, 6715)).toBe(
      '正在扫描词库 1250 / 6715（19%） · 预计约 1 分钟',
    )
    expect(formatMaimemoScanProgress(0, 6715)).toBe('正在扫描词库 0 / 6715（0%） · 预计约 1 分钟')
    expect(formatMaimemoScanProgress(6715, 6715)).toContain('100%')
    expect(formatMaimemoScanProgress(1250, 6715)).not.toContain('已导入')
  })

  it('未知总数：显示扫描中 + 约 1 分钟', () => {
    expect(formatMaimemoScanProgress(0, 0)).toContain('正在扫描词库')
    expect(formatMaimemoScanProgress(0, 0)).toContain('可取消')
  })

  it('按已用时间估算剩余秒数（有 startedAt 时）', () => {
    // 10 秒扫描 1000/2000 → 剩余约 10 秒
    expect(formatMaimemoScanProgress(1000, 2000, { startedAt: 0, now: 10_000 })).toBe(
      '正在扫描词库 1000 / 2000（50%） · 预计剩余 10 秒',
    )
    // 剩余时间封顶 90 秒
    expect(formatMaimemoScanProgress(10, 10_000, { startedAt: 0, now: 100_000 })).toContain(
      '预计剩余 90 秒',
    )
  })

  it('取消：AbortController 句柄 abort 后 signal.aborted=true（可重复调用）', () => {
    const handle = createMaimemoAbortHandle()
    expect(handle.signal.aborted).toBe(false)
    handle.abort()
    expect(handle.signal.aborted).toBe(true)
    expect(() => handle.abort()).not.toThrow()
  })

  it('isMaimemoCancelled 只识别 E_CANCELLED（静默处理）', () => {
    expect(isMaimemoCancelled({ code: 'E_CANCELLED' })).toBe(true)
    expect(isMaimemoCancelled({ code: 'E_NETWORK' })).toBe(false)
    expect(isMaimemoCancelled(null)).toBe(false)
  })

  it('E_CANCELLED 文案为「导入已取消」；限流/异常有针对性文案', () => {
    expect(describeMaimemoFailure({ code: 'E_CANCELLED' }, 'native')).toBe('导入已取消')
    const rate = describeMaimemoFailure({ code: 'E_RATE_LIMITED' }, 'native')
    expect(rate).toContain('限流')
    expect(rate).toContain('稍等')
    const bad = describeMaimemoFailure({ code: 'E_BAD_RESPONSE' }, 'proxy')
    expect(bad).toContain('接口返回异常')
    expect(bad).toContain('稍后重试')
  })
})

describe('墨墨导入结果摘要', () => {
  it('成功摘要：匹配/未匹配/跳过/总数/耗时', () => {
    const info = formatMaimemoSummary({
      ok: true,
      matched: 120,
      unmatched: ['foo', 'bar'],
      unmatchedCount: 2,
      skipped: 3,
      totalRecords: 125,
      durationMs: 2400,
      issues: [],
    })
    expect(info.ok).toBe(true)
    expect(info.summary).toBe(
      '匹配 120 词 · 未匹配 2 个 · 跳过 3 条 · 共 125 条记录 · 用时 2.4 秒',
    )
  })

  it('失败摘要：取第一条 error issue；无 issue 时给兜底', () => {
    const withIssue = formatMaimemoSummary({
      ok: false,
      matched: 0,
      skipped: 0,
      totalRecords: 0,
      durationMs: 10,
      issues: [{ level: 'error', message: 'Token 失效', code: 'E_UNAUTHORIZED' }],
    })
    expect(withIssue.ok).toBe(false)
    expect(withIssue.summary).toContain('Token 失效')

    const empty = formatMaimemoSummary({
      ok: false,
      matched: 0,
      skipped: 0,
      totalRecords: 0,
      durationMs: 10,
      issues: [],
    })
    expect(empty.summary).toContain('导入失败')
  })
})
