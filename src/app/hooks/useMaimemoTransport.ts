/**
 * 墨墨导入通道的 UI 适配（task-39）：APK 原生直连 vs 浏览器本地代理。
 *
 * 原生桥协议（arch task-37，data task-38 内部消费）：
 *   window.MomoApi.isNativeApp() === 'momo-apk'
 * 检测统一来自 data 层 `isNativeHttpAvailable()`（task-38）；本文件只做纯展示/文案映射，不直接发 HTTP。
 */

export type MaimemoTransport = 'native' | 'proxy'

export interface MaimemoTransportView {
  transport: MaimemoTransport
  isNative: boolean
  /** 是否显示「代理地址」输入（APK 内置直连时隐藏） */
  showProxyInput: boolean
  /** 当前是否允许点「开始导入」 */
  canImport: boolean
  /** 模式标签，如「内置直连（无需代理）」/「本地代理」 */
  modeLabel: string
  /** 模式说明 */
  modeDescription: string
  /** 隐私说明 */
  privacyText: string
  /** PWA 代理模式的操作提示（含启动代理命令） */
  proxyHint: string
  /** PWA 未填代理时的明确提示（null = 无问题） */
  missingProxyMessage: string | null
}

/** 浏览器 / PWA 需要本机代理（data 层同款默认值） */
export const DEFAULT_PROXY_hint = '需在本机运行 node src/data/api/maimemo-proxy.mjs 并填写代理地址'
export const DEFAULT_PROXY_URL = 'http://127.0.0.1:8787'

/** 解析当前导入模式（纯函数，便于单测） */
export function resolveMaimemoTransport(input: {
  nativeAvailable: boolean
  proxyUrl: string
}): MaimemoTransportView {
  if (input.nativeAvailable) {
    return {
      transport: 'native',
      isNative: true,
      showProxyInput: false,
      canImport: true,
      modeLabel: '内置直连（无需代理）',
      modeDescription: '当前为 APK：墨墨请求由 App 内置网络直连完成，不需要代理地址。',
      privacyText: '进度只写本机，不上传服务器；Token 只存本机。',
      proxyHint: '',
      missingProxyMessage: null,
    }
  }
  const proxyUrl = input.proxyUrl.trim()
  return {
    transport: 'proxy',
    isNative: false,
    showProxyInput: true,
    canImport: proxyUrl.length > 0,
    modeLabel: '本地代理',
    modeDescription: '浏览器/PWA 受跨域限制，需通过本机代理访问墨墨开放 API。',
    privacyText: '进度只写本机，不上传服务器；Token 只存本机。',
    proxyHint: proxyUrl
      ? '请保持代理进程运行：node src/data/api/maimemo-proxy.mjs'
      : DEFAULT_PROXY_hint,
    missingProxyMessage: proxyUrl
      ? null
      : '未填写代理地址：请先在本机运行 node src/data/api/maimemo-proxy.mjs，再填写代理地址（浏览器直连会被 CORS 拦截）。',
  }
}

/** data.maimemoMessageFor 的最小结构（便于注入/单测） */
export type MaimemoMessageLookup = (code: string) => {
  title: string
  hint: string
  action?: string
} | undefined

/**
 * MaimemoError 的 UI 文案映射。
 * 优先使用 `data.maimemoMessageFor(code)`（task-38：按 APK/浏览器环境返回不同文案，
 * 原生模式下网络错误不会出现「配置代理/CORS」）；未提供 lookup 时使用本地兜底。
 */
export function describeMaimemoFailure(
  error: { code?: string; message?: string } | null | undefined,
  transport: MaimemoTransport,
  lookup?: MaimemoMessageLookup,
): string {
  const code = error?.code ?? ''
  const fallback = error?.message?.trim() || '导入失败，请稍后重试'
  if (code && lookup) {
    try {
      const message = lookup(code)
      if (message?.title || message?.hint) {
        return message.hint ? `${message.title}：${message.hint}` : message.title
      }
    } catch {
      /* lookup 异常时走本地兜底 */
    }
  }
  switch (code) {
    case 'E_NO_TOKEN':
      return '未配置墨墨 Token：请在墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API 复制后粘贴。'
    case 'E_UNAUTHORIZED':
      return 'Token 失效或不正确：Token 约 7 天有效，请重新获取后粘贴。'
    case 'E_FORBIDDEN':
      return 'Token 没有学习数据权限：请在墨墨 App 确认已开启开放 API 与学习数据同步。'
    case 'E_RATE_LIMITED':
      return '墨墨接口限流：请求过于频繁，请稍等 1–2 分钟后再重试。'
    case 'E_BAD_RESPONSE':
      return '墨墨接口返回异常（可能忽略过滤参数）：请稍后重试；多次失败请重新获取 Token。'
    case 'E_CANCELLED':
      return '导入已取消'
    case 'E_TIMEOUT':
    case 'E_NETWORK':
      return transport === 'native'
        ? '网络失败或 Token 失效：请检查手机网络后重试；若仍失败请重新粘贴 Token。'
        : '网络失败：请检查网络与本地代理是否在运行。'
    case 'E_CORS':
      return transport === 'native'
        ? '网络失败或 Token 失效：请检查手机网络后重试；若仍失败请重新粘贴 Token。'
        : '跨域被拦截：请在本机运行 node src/data/api/maimemo-proxy.mjs，并填写正确的代理地址后重试。'
    case 'E_SERVER':
      return '墨墨服务返回异常：请稍后重试；多次失败请检查 Token 是否有效。'
    case 'E_BAD_INPUT':
      return '请求参数不合法：请检查 Token/代理地址格式。'
    case 'E_NOT_IMPLEMENTED':
      return '当前版本暂不支持该导入方式，请升级 App 后重试。'
    default:
      return transport === 'native'
        ? `导入失败：${fallback}（请检查网络或 Token）`
        : `导入失败：${fallback}`
  }
}

/**
 * 「正在扫描词库 X/Y」进度文案（task-40 新语义：已扫描词数 / 总词数，不是导入记录数）。
 * @param opts.startedAt 开始时间（估算剩余秒数用；缺省显示「预计约 1 分钟」）
 */
export function formatMaimemoScanProgress(
  scanned: number,
  total: number,
  opts: { startedAt?: number; now?: number } = {},
): string {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  const safeScanned = Number.isFinite(scanned)
    ? Math.min(safeTotal || Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(scanned)))
    : 0
  if (safeTotal <= 0) return '正在扫描词库…（预计约 1 分钟，可取消）'
  const percent = Math.min(100, Math.round((safeScanned / safeTotal) * 100))
  const base = `正在扫描词库 ${safeScanned} / ${safeTotal}（${percent}%）`
  const now = opts.now ?? Date.now()
  const startedAt = opts.startedAt
  if (startedAt != null && now > startedAt && safeScanned > 0) {
    const elapsedSeconds = (now - startedAt) / 1000
    const remainingSeconds = ((safeTotal - safeScanned) / safeScanned) * elapsedSeconds
    if (Number.isFinite(remainingSeconds) && remainingSeconds >= 1) {
      return `${base} · 预计剩余 ${Math.min(90, Math.max(1, Math.round(remainingSeconds)))} 秒`
    }
  }
  return `${base} · 预计约 1 分钟`
}

/** 可取消导入的句柄（task-41：页面/弹层关闭时 abort） */
export interface MaimemoAbortHandle {
  controller: AbortController
  signal: AbortSignal
  abort: () => void
}

export function createMaimemoAbortHandle(): MaimemoAbortHandle {
  const controller = new AbortController()
  return { controller, signal: controller.signal, abort: () => controller.abort() }
}

/** 是否用户主动取消（E_CANCELLED，静默处理不报错） */
export function isMaimemoCancelled(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'E_CANCELLED'
}

/** 导入结果摘要（匹配/未匹配/跳过/总数/耗时） */
export function formatMaimemoSummary(result: {
  ok: boolean
  matched: number
  unmatched?: string[]
  unmatchedCount?: number
  skipped: number
  totalRecords: number
  durationMs: number
  issues?: Array<{ level: 'error' | 'warning'; message: string; code: string }>
}): { ok: boolean; summary: string; detail?: string } {
  const unmatched = result.unmatchedCount ?? result.unmatched?.length ?? 0
  const seconds = Math.max(0, result.durationMs) / 1000
  const summary = `匹配 ${result.matched} 词 · 未匹配 ${unmatched} 个 · 跳过 ${result.skipped} 条 · 共 ${result.totalRecords} 条记录 · 用时 ${seconds.toFixed(1)} 秒`
  if (result.ok) return { ok: true, summary }
  const issue = result.issues?.find((item) => item.level === 'error')
  return {
    ok: false,
    summary: issue ? `导入失败：${issue.message}` : '导入失败：未匹配到任何记录',
    detail: issue?.code,
  }
}
