/**
 * 墨墨开放 API 客户端（SPEC §7.2 / D45）。
 *
 * 实测口径（Lead 真实 Token 联调，D45）：
 * - base `https://open.maimemo.com/open/api/v1/memo`，头 `Authorization: Bearer <token>`；
 * - 成功外壳 `{success:true, errors:[], data:{...}}`（也兼容裸数据体）；
 * - `query_study_records`：**limit ≤ 200**（1000 会 500）、**无 offset**、用 `next_study_date`
 *   时间窗（格式必须 `YYYY-MM-DD HH:mm:ss+00:00`，写 ISO Z 会 500）分页；
 * - 频控：10s/20、60s/40、5h/2000；实测 ~1.7s/请求 + 指数退避最稳。
 *
 * 设计：网络层完全可注入（`fetchImpl` / `sleep` / `now` / `random`），单测不碰真实网络。
 * 错误分类见 `MaimemoErrorCode`；401/403 不重试，429/5xx/超时按 1s/2s/4s 退避重试。
 */

import type { MaimemoError, MaimemoErrorCode, StudyRecord } from './maimemo-types'
import { isNativeHttpAvailable, nativeFetch } from './native-http'

const DEFAULT_BASE_URL = 'https://open.maimemo.com/open/api/v1/memo'
const LEGACY_BASE_URL = 'https://open.maimemo.com/open/api/v1'
const PAGE_LIMIT = 200
const DAY_MS = 86_400_000

export interface MaimemoClientOptions {
  token: string
  /** 本地代理地址（如 http://127.0.0.1:8787）；留空 = 直连（浏览器会 CORS 失败） */
  proxyUrl?: string
  /** 覆盖 API base（测试用） */
  baseUrl?: string
  /** 覆盖 fetch（测试用） */
  fetchImpl?: typeof fetch
  /** 覆盖 sleep（测试用；传 no-op 可跳过节流等待） */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  /** 单请求超时（默认 30s） */
  timeoutMs?: number
  /** 限流/超时/5xx 最大重试次数（默认 3） */
  maxRetries?: number
  /** 两次请求最小间隔（默认 1700ms，D45 实测值） */
  minIntervalMs?: number
  /** 单次拉全量最大请求数（防失控，默认 300） */
  maxPages?: number
  /** 是否启用客户端限流（默认 true；测试可关） */
  throttle?: boolean
  /**
   * 强制指定传输模式（测试/特殊宿主用）：
   * - true → 走 APK 原生 HTTP 桥（直连 open.maimemo.com，忽略 proxyUrl）；
   * - false → 走浏览器 fetch（需要 proxyUrl 跨域代理）；
   * - 缺省 → 自动检测 `isNativeHttpAvailable()`。
   */
  native?: boolean
}

/** 构造分类错误 */
export function makeMaimemoError(
  code: MaimemoErrorCode,
  message: string,
  extra: { status?: number; serverCode?: string; retryable?: boolean; cause?: unknown } = {},
): MaimemoError {
  const error = new Error(message) as MaimemoError
  error.name = 'MaimemoError'
  error.code = code
  if (extra.status != null) error.status = extra.status
  if (extra.serverCode) error.serverCode = extra.serverCode
  error.retryable = extra.retryable ?? false
  if (extra.cause !== undefined) (error as { cause?: unknown }).cause = extra.cause
  return error
}

/** 是否墨墨通道错误 */
export function isMaimemoError(value: unknown): value is MaimemoError {
  return (
    value instanceof Error &&
    typeof (value as MaimemoError).code === 'string' &&
    (value as MaimemoError).name === 'MaimemoError'
  )
}

/**
 * epoch ms → 官方时间串 `YYYY-MM-DD HH:mm:ss+00:00`。
 * 语义：官方返回的“北京时间”墙上时间 + 固定 `+00:00` 后缀（D45），这里按北京时间格式化。
 */
export function formatMaimemoDate(timestamp: number): string {
  const shifted = new Date(timestamp + 8 * 3_600_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}+00:00`
}

/**
 * 官方时间串 → epoch ms。
 * 官方时间串固定以 `+00:00` 结尾，但实际是**北京时间**（SPEC §7.2 / research 实测）。
 * 兼容带空格/`T`、带真实偏移量（+08:00 / Z）的写法。
 */
export function parseMaimemoDate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(
    text,
  )
  if (!match) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
  }
  const [, y, mo, d, hh, mi, ss, zone] = match
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mi),
    Number(ss),
  )
  if (!zone || zone === '+00:00' || zone === '+0000' || zone.toUpperCase() === 'Z') {
    // 官方语义：这是北京时间墙钟 → UTC+8
    return utc - 8 * 3_600_000
  }
  if (zone === '+08:00' || zone === '+0800') return utc - 8 * 3_600_000
  const sign = zone.startsWith('-') ? -1 : 1
  const digits = zone.replace(/[^0-9]/g, '')
  const offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
  return utc - offsetMinutes * 60_000
}

/** 滑窗限流器：minInterval + 多窗口上限 */
class RateLimiter {
  private stamps: number[] = []

  constructor(
    private readonly options: {
      minIntervalMs: number
      windows: Array<{ spanMs: number; max: number }>
      now: () => number
      sleep: (ms: number) => Promise<void>
    },
  ) {}

  private prune(now: number): void {
    const longest = Math.max(...this.options.windows.map((window) => window.spanMs), 0)
    const cutoff = now - longest
    while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift()
  }

  async acquire(): Promise<void> {
    const { minIntervalMs, windows, now, sleep } = this.options
    for (let guard = 0; guard < 1000; guard += 1) {
      const current = now()
      this.prune(current)
      let wait = 0
      const last = this.stamps[this.stamps.length - 1]
      if (last != null && minIntervalMs > 0) {
        wait = Math.max(wait, last + minIntervalMs - current)
      }
      for (const window of windows) {
        const inWindow = this.stamps.filter((stamp) => stamp > current - window.spanMs)
        if (inWindow.length >= window.max) {
          const oldest = inWindow[inWindow.length - window.max] ?? inWindow[0]!
          wait = Math.max(wait, oldest + window.spanMs - current)
        }
      }
      if (wait <= 0) {
        this.stamps.push(current)
        return
      }
      await sleep(Math.min(wait, 3_600_000))
    }
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** 使用旧版 base（`/open/api/v1`，兼容没有 `/memo/` 的路径） */
  legacyBase?: boolean
  /** 跳过解析，原样返回响应文本（调试用） */
  raw?: boolean
}

interface ApiEnvelope<T> {
  success?: boolean
  errors?: Array<{ code?: string; msg?: string; info?: string }>
  data?: T
  [key: string]: unknown
}

export class MaimemoClient {
  private readonly token: string
  private readonly proxyUrl: string
  private readonly baseUrl: string
  private readonly legacyBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly random: () => number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly maxPages: number
  private readonly limiter: RateLimiter
  private requestCount = 0
  /** 传输模式：native = APK 原生直连（无 CORS/代理）；browser = 浏览器 fetch（需代理） */
  readonly transportMode: 'native' | 'browser'

  constructor(options: MaimemoClientOptions) {
    if (!options.token || !options.token.trim()) {
      throw makeMaimemoError('E_NO_TOKEN', '未配置墨墨 Token')
    }
    this.token = options.token.trim()
    this.proxyUrl = (options.proxyUrl ?? '').trim().replace(/\/+$/, '')
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.legacyBaseUrl = options.baseUrl ? options.baseUrl.replace(/\/memo\/?$/, '') : LEGACY_BASE_URL
    // APK（原生 HTTP 桥可用）→ 直连 open.maimemo.com，忽略代理；浏览器 → fetch + 代理
    const nativeMode = options.native ?? isNativeHttpAvailable()
    this.transportMode = nativeMode ? 'native' : 'browser'
    this.fetchImpl =
      options.fetchImpl ??
      (nativeMode
        ? (input, init) => nativeFetch(String(input), init)
        : ((input, init) => fetch(input, init)))
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? (() => Math.random())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxRetries = Math.max(0, options.maxRetries ?? 3)
    this.maxPages = Math.max(1, options.maxPages ?? 300)
    this.limiter = new RateLimiter({
      minIntervalMs: options.throttle === false ? 0 : (options.minIntervalMs ?? 1_700),
      windows: [
        { spanMs: 10_000, max: 20 },
        { spanMs: 60_000, max: 40 },
        { spanMs: 5 * 3_600_000, max: 2_000 },
      ],
      now: this.now,
      sleep: this.sleep,
    })
  }

  /** 已发出的请求数（含重试） */
  get requestCountValue(): number {
    return this.requestCount
  }

  private buildUrl(path: string, legacyBase = false): string {
    const base = legacyBase ? this.legacyBaseUrl : this.baseUrl
    const url = new URL(`${base}${path}`)
    // 原生直连（APK）：不拼 proxyUrl，直接 https://open.maimemo.com/...
    if (this.transportMode === 'native') return url.toString()
    if (!this.proxyUrl) return url.toString()
    // 经本地代理：代理把 pathname 原样转发到 https://open.maimemo.com
    return `${this.proxyUrl}${url.pathname}${url.search}`
  }

  /** 单次 fetch（带超时） */
  private async fetchOnce(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private classifyNetworkError(error: unknown): MaimemoError {
    const name = error instanceof Error ? error.name : ''
    if (name === 'AbortError' || /aborted|timeout/i.test(String(error))) {
      return makeMaimemoError('E_TIMEOUT', '请求超时', { retryable: true, cause: error })
    }
    const message = error instanceof Error ? error.message : String(error)
    if (this.transportMode === 'native') {
      // APK 原生直连：不存在 CORS/代理问题，失败就是网络或 Token
      return makeMaimemoError('E_NETWORK', '网络失败，请检查网络或 Token', {
        retryable: false,
        cause: error,
      })
    }
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
      // 浏览器里 CORS 与断网都表现为 TypeError: Failed to fetch
      return makeMaimemoError(
        'E_NETWORK',
        '网络请求失败（浏览器直连会被 CORS 拦截，请配置本地代理）',
        { retryable: false, cause: error },
      )
    }
    return makeMaimemoError('E_NETWORK', `网络请求失败：${message}`, {
      retryable: true,
      cause: error,
    })
  }

  private statusToError(status: number, serverCode?: string): MaimemoError {
    if (status === 401) return makeMaimemoError('E_UNAUTHORIZED', 'Token 失效或错误（HTTP 401）', { status, serverCode })
    if (status === 403) return makeMaimemoError('E_FORBIDDEN', '没有权限访问（HTTP 403）', { status, serverCode })
    if (status === 429 || status === 503) {
      return makeMaimemoError('E_RATE_LIMITED', `请求被限流（HTTP ${status}）`, {
        status,
        serverCode,
        retryable: true,
      })
    }
    if (status >= 500) {
      return makeMaimemoError('E_SERVER', `墨墨服务异常（HTTP ${status}）`, {
        status,
        serverCode,
        retryable: true,
      })
    }
    return makeMaimemoError('E_BAD_RESPONSE', `接口返回异常状态（HTTP ${status}）`, { status, serverCode })
  }

  /** 统一请求：限流 → 超时 fetch → 错误分类 → 退避重试 → 解包 */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET'
    const url = this.buildUrl(path, options.legacyBase)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined) init.body = JSON.stringify(options.body)

    let lastError: MaimemoError | null = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.limiter.acquire()
      this.requestCount += 1
      try {
        const response = await this.fetchOnce(url, init)
        const text = await response.text()
        let body: ApiEnvelope<T> | null = null
        if (text) {
          try {
            body = JSON.parse(text) as ApiEnvelope<T>
          } catch {
            if (!response.ok) throw this.statusToError(response.status)
            throw makeMaimemoError('E_BAD_RESPONSE', '墨墨返回了非 JSON 数据')
          }
        }
        if (!response.ok) {
          const serverError = body?.errors?.[0]
          throw this.statusToError(response.status, serverError?.code)
        }
        if (!body) throw makeMaimemoError('E_BAD_RESPONSE', '墨墨返回了空响应')
        if (body.success === false || (Array.isArray(body.errors) && body.errors.length > 0)) {
          const serverError = body.errors?.[0]
          const code = this.mapServerCode(serverError?.code)
          const message = serverError?.msg ?? serverError?.info ?? '墨墨接口返回错误'
          throw makeMaimemoError(code, message, {
            serverCode: serverError?.code,
            retryable: code === 'E_RATE_LIMITED' || code === 'E_SERVER',
          })
        }
        if (options.raw) return body as unknown as T
        return (body.data ?? (body as unknown)) as T
      } catch (error) {
        const classified = isMaimemoError(error) ? error : this.classifyNetworkError(error)
        lastError = classified
        if (!classified.retryable || attempt >= this.maxRetries) throw classified
        const backoff = 1000 * 2 ** attempt + Math.floor(this.random() * 250)
        await this.sleep(backoff)
      }
    }
    throw lastError ?? makeMaimemoError('E_NETWORK', '请求失败')
  }

  private mapServerCode(serverCode?: string): MaimemoErrorCode {
    const code = (serverCode ?? '').toLowerCase()
    if (code.includes('unauthorized') || code.includes('auth')) return 'E_UNAUTHORIZED'
    if (code.includes('forbidden') || code.includes('permission')) return 'E_FORBIDDEN'
    if (code.includes('rate') || code.includes('limit') || code.includes('too_many')) return 'E_RATE_LIMITED'
    if (code.includes('not_found')) return 'E_BAD_RESPONSE'
    if (code.includes('internal')) return 'E_SERVER'
    return 'E_BAD_RESPONSE'
  }

  // ============ 业务接口 ============

  /** 学习记录：按 `next_study_date` 时间窗查询（无 offset） */
  async queryStudyRecords(params: {
    start?: string
    end?: string
    limit?: number
    asCount?: boolean
    spellings?: string[]
    vocIds?: string[]
  }): Promise<{ records: StudyRecord[]; count: number | null }> {
    const body: Record<string, unknown> = {}
    if (params.start || params.end) {
      body.next_study_date = {
        ...(params.start ? { start: params.start } : {}),
        ...(params.end ? { end: params.end } : {}),
      }
    }
    if (params.limit != null) body.limit = Math.min(PAGE_LIMIT, Math.max(1, Math.floor(params.limit)))
    if (params.asCount) body.as_count = true
    if (params.spellings?.length) body.spellings = params.spellings
    if (params.vocIds?.length) body.voc_ids = params.vocIds
    const data = await this.request<{ records?: StudyRecord[]; count?: number }>(
      '/study/query_study_records',
      { method: 'POST', body },
    )
    return {
      records: Array.isArray(data?.records) ? data.records : [],
      count: typeof data?.count === 'number' ? data.count : null,
    }
  }

  /** 学习记录总数（`as_count:true`） */
  async getStudyRecordsCount(): Promise<number> {
    const { count } = await this.queryStudyRecords({ asCount: true })
    return typeof count === 'number' && Number.isFinite(count) ? count : 0
  }

  /** 今日学习进度（可选增强） */
  async getStudyProgress(): Promise<{ finished: number; total: number; studyTime: number }> {
    const data = await this.request<{
      progress?: { finished?: number; total?: number; study_time?: number }
    }>('/study/get_study_progress', { method: 'POST', body: {} })
    const progress = data?.progress ?? {}
    return {
      finished: Number(progress.finished ?? 0),
      total: Number(progress.total ?? 0),
      studyTime: Number(progress.study_time ?? 0),
    }
  }

  /** 单词拼写 → voc_id（单个） */
  async getVocabulary(spelling: string): Promise<{ id: string; spelling: string } | null> {
    const data = await this.request<{ voc?: { id?: string; spelling?: string } }>(
      `/vocabulary?spelling=${encodeURIComponent(spelling)}`,
    )
    const voc = data?.voc
    if (!voc?.id) return null
    return { id: String(voc.id), spelling: String(voc.spelling ?? spelling) }
  }

  /** 批量拼写 → voc_id（≤1000） */
  async queryVocabularies(spellings: string[]): Promise<Array<{ id: string; spelling: string }>> {
    if (spellings.length === 0) return []
    const data = await this.request<{ voc?: Array<{ id?: string; spelling?: string }> }>(
      '/vocabulary/query',
      { method: 'POST', body: { spellings: spellings.slice(0, 1000) } },
    )
    if (!Array.isArray(data?.voc)) return []
    return data.voc
      .filter((item) => item?.id)
      .map((item) => ({ id: String(item.id), spelling: String(item.spelling ?? '') }))
  }

  // ============ 全量学习记录拉取（task-40 分页策略 v2） ============

  /**
   * 拉全量学习记录（SPEC §7 / task-40）。
   *
   * **策略 v2（推荐，默认）**：按本地词库拼写 `spellings` 批量查询。
   * 日期窗口分页已被实测证明不可靠（两页返回同一批、不按 next_study_date 排序、as_count 自相矛盾），
   * 因此只在没有拼写列表时作为兜底，且**有硬请求上限、不再无限二分**。
   *
   * 拼写批量策略：
   * - 本地词库 headword 归一化去重 → 每批 `batchSize`（默认 500）个拼写；
   * - 每批返回记录若达到 `pageLimit`（默认 200，服务端单页上限）→ 认为可能被截断，**按拼写集合二分重查**（有界）；
   * - 每批返回记录里出现**不在本批 spellings 的拼写** → 判定服务端忽略过滤，立即抛 `E_BAD_RESPONSE`（不静默降级）；
   * - 批间最小间隔 `minIntervalMs`（默认 3200ms，实测 1.6–2.6s 会被限流）；
   * - 总请求上限 `maxRequests`（默认 80，含重试）；超限抛 `E_RATE_LIMITED` 明确错误；
   * - 进度回调语义 = **已扫描词数 / 总词数**（避免"卡死"错觉）；
   * - 支持 `AbortSignal` 取消（抛 `E_CANCELLED`）；按 `voc_id`（缺失用 spelling）去重。
   */
  async fetchAllStudyRecords(
    optsOrOnProgress: FetchAllRecordsOptions | ((scanned: number, total: number) => void) = {},
  ): Promise<FetchAllRecordsResult> {
    const opts: FetchAllRecordsOptions =
      typeof optsOrOnProgress === 'function'
        ? { onProgress: optsOrOnProgress }
        : optsOrOnProgress
    const spellings = normalizeSpellingList(opts.spellings ?? [])
    if (spellings.length > 0) return this.fetchBySpellings(spellings, opts)
    return this.fetchByDateWindow(opts)
  }

  /** 按拼写批量查询（推荐策略） */
  private async fetchBySpellings(
    spellings: string[],
    opts: FetchAllRecordsOptions,
  ): Promise<FetchAllRecordsResult> {
    const totalWords = spellings.length
    const batchSize = clampInt(opts.batchSize ?? 500, 1, 1000)
    const pageLimit = clampInt(opts.pageLimit ?? 200, 1, PAGE_LIMIT)
    const minIntervalMs = Math.max(0, opts.minIntervalMs ?? 3_200)
    const maxRequests = clampInt(opts.maxRequests ?? 80, 1, 500)
    const startedAt = Date.now()
    const startCount = this.requestCount
    const seen = new Map<string, StudyRecord>()
    let scanned = 0
    let lastRequestAt = 0

    const abortIfNeeded = (): void => {
      if (opts.signal?.aborted) {
        throw makeMaimemoError('E_CANCELLED', '导入已取消')
      }
    }
    const ensureBudget = (): void => {
      const used = this.requestCount - startCount
      if (used >= maxRequests) {
        throw makeMaimemoError(
          'E_RATE_LIMITED',
          `按拼写分页请求超过上限（${maxRequests} 次，已扫描 ${scanned}/${totalWords} 词），` +
            '为避免触发频控已停止；请稍后重试或改用文件导入',
        )
      }
    }
    const collect = (records: StudyRecord[]): void => {
      for (const record of records) {
        if (!record || typeof record !== 'object') continue
        const key = record.voc_id
          ? `id:${record.voc_id}`
          : `sp:${String(record.voc_spelling ?? '').toLowerCase()}`
        if (key === 'sp:') continue
        const existing = seen.get(key)
        if (!existing) {
          seen.set(key, record)
          continue
        }
        const existingDate = parseMaimemoDate(existing.last_study_date) ?? -Infinity
        const nextDate = parseMaimemoDate(record.last_study_date) ?? -Infinity
        if (nextDate >= existingDate) seen.set(key, record)
      }
    }

    const queryBatch = async (batch: string[], depth: number): Promise<void> => {
      abortIfNeeded()
      ensureBudget()
      const wait = Math.max(0, lastRequestAt + minIntervalMs - Date.now())
      if (wait > 0) await this.sleep(wait)
      lastRequestAt = Date.now()
      const page = await this.queryStudyRecords({
        spellings: batch,
        limit: pageLimit,
      })
      // 过滤被忽略 → 立刻报错（不静默用全量数据，避免"导入别人词表"）
      const batchSet = new Set(batch.map((word) => normalizeSpellingValue(word)))
      const outside = page.records.filter(
        (record) => !batchSet.has(normalizeSpellingValue(record.voc_spelling)),
      )
      if (outside.length > 0) {
        throw makeMaimemoError(
          'E_BAD_RESPONSE',
          `墨墨接口未按 spellings 过滤（返回 ${outside.length} 条不在本批的拼写，如「${
            outside[0]?.voc_spelling ?? ''
          }」），已停止导入；请改用文件导入或稍后重试`,
        )
      }
      collect(page.records)
      const truncated = page.records.length >= pageLimit
      if (truncated && batch.length > 1 && depth < 8) {
        // 可能被单页上限截断：按拼写集合二分重查（有界，深度 ≤8）
        const mid = Math.floor(batch.length / 2)
        await queryBatch(batch.slice(0, mid), depth + 1)
        await queryBatch(batch.slice(mid), depth + 1)
        return
      }
      scanned += batch.length
      opts.onProgress?.(Math.min(scanned, totalWords), totalWords)
    }

    for (let i = 0; i < spellings.length; i += batchSize) {
      abortIfNeeded()
      await queryBatch(spellings.slice(i, i + batchSize), 0)
    }
    opts.onProgress?.(totalWords, totalWords)
    return {
      records: [...seen.values()],
      pages: this.requestCount - startCount,
      total: 0, // 拼写策略下"总记录数"未知（as_count 不可靠，不请求）
      strategy: 'spellings',
      scanned: totalWords,
      durationMs: Date.now() - startedAt,
    }
  }

  /** 兜底：日期窗口分页（不可靠；有硬上限、不做无限二分） */
  private async fetchByDateWindow(opts: FetchAllRecordsOptions): Promise<FetchAllRecordsResult> {
    const startedAt = Date.now()
    const startCount = this.requestCount
    const now = this.now()
    const maxRequests = clampInt(opts.maxRequests ?? this.maxPages, 1, 500)
    const seen = new Map<string, StudyRecord>()
    // as_count 不可靠（仅作进度分母的粗略估计；失败不影响）
    const total = await this.getStudyRecordsCount().catch(() => 0)
    let requests = 0

    const abortIfNeeded = (): void => {
      if (opts.signal?.aborted) throw makeMaimemoError('E_CANCELLED', '导入已取消')
    }
    const ensureBudget = (): void => {
      if (requests + 1 > maxRequests) {
        throw makeMaimemoError(
          'E_RATE_LIMITED',
          `日期窗口分页超过请求上限（${maxRequests} 次）；该接口分页不可靠，` +
            '请改用「按拼写批量」导入或文件导入',
        )
      }
    }
    const addRecords = (records: StudyRecord[]): void => {
      for (const record of records) {
        const key = record.voc_id
          ? `id:${record.voc_id}`
          : `sp:${String(record.voc_spelling ?? '').toLowerCase()}`
        if (key === 'sp:') continue
        const existing = seen.get(key)
        if (!existing) {
          seen.set(key, record)
          continue
        }
        const existingDate = parseMaimemoDate(existing.last_study_date) ?? -Infinity
        const nextDate = parseMaimemoDate(record.last_study_date) ?? -Infinity
        if (nextDate >= existingDate) seen.set(key, record)
      }
    }
    const fetchPage = async (start: string, end: string): Promise<StudyRecord[]> => {
      abortIfNeeded()
      ensureBudget()
      requests += 1
      const page = await this.queryStudyRecords({ start, end, limit: PAGE_LIMIT })
      return page.records
    }

    let cursor = formatMaimemoDate(now - 10 * 365 * DAY_MS)
    const end = formatMaimemoDate(now + 10 * 365 * DAY_MS)
    for (let guard = 0; guard <= maxRequests; guard += 1) {
      const records = await fetchPage(cursor, end)
      addRecords(records)
      opts.onProgress?.(seen.size, Math.max(seen.size, total))
      if (records.length < PAGE_LIMIT) break
      // 顺序校验：不升序说明接口不可靠 → 明确失败（不再二分死循环）
      let previous = -Infinity
      let sorted = true
      for (const record of records) {
        const time = parseMaimemoDate(record.next_study_date)
        if (time == null || time < previous) {
          sorted = false
          break
        }
        previous = time
      }
      const lastDate = parseMaimemoDate(records[records.length - 1]?.next_study_date)
      const cursorMs = parseMaimemoDate(cursor)
      if (!sorted || lastDate == null || cursorMs == null || lastDate <= cursorMs) {
        throw makeMaimemoError(
          'E_BAD_RESPONSE',
          '墨墨日期窗口分页不可靠（未按 next_study_date 排序或无法推进），已停止；' +
            '请改用「按拼写批量」导入或文件导入',
        )
      }
      cursor = formatMaimemoDate(lastDate)
    }
    return {
      records: [...seen.values()],
      pages: this.requestCount - startCount,
      total,
      strategy: 'window',
      scanned: seen.size,
      durationMs: Date.now() - startedAt,
    }
  }
}

/** 归一化拼写（trim/合并空白/小写） */
function normalizeSpellingValue(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** 拼写列表去重（保留首次出现的原始拼写） */
function normalizeSpellingList(spellings: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const spelling of spellings) {
    const normalized = normalizeSpellingValue(spelling)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(String(spelling).trim())
  }
  return out
}

function clampInt(value: number, min: number, max: number): number {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, num))
}

/** `fetchAllStudyRecords` 选项（task-40） */
export interface FetchAllRecordsOptions {
  /** 本地词库拼写列表（优先策略）；为空则退回日期窗口兜底 */
  spellings?: string[]
  /** 每批拼写数（默认 500） */
  batchSize?: number
  /** 每批请求的 limit（默认 200，服务端单页上限；返回满页会拆半重查） */
  pageLimit?: number
  /** 批间最小间隔 ms（默认 3200） */
  minIntervalMs?: number
  /** 总请求上限（默认 80） */
  maxRequests?: number
  signal?: AbortSignal
  /** 进度：已扫描词数 / 总词数 */
  onProgress?: (scanned: number, total: number) => void
}

/** `fetchAllStudyRecords` 结果（task-40） */
export interface FetchAllRecordsResult {
  records: StudyRecord[]
  pages: number
  /** 服务端 as_count 估计总数（拼写策略下不请求，恒 0） */
  total: number
  strategy: 'spellings' | 'window'
  /** 已扫描词数（拼写策略 = 全部词；窗口策略 = 已接收记录数） */
  scanned: number
  durationMs: number
}

export function createMaimemoClient(options: MaimemoClientOptions): MaimemoClient {
  return new MaimemoClient(options)
}
