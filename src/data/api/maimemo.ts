/**
 * 墨墨导入通道编排层（SPEC §7 / task-8 / D43–D46）。
 *
 * 能力边界（不可越线）：
 * - 只导「已学单词 + 复习进度」，**不导**墨墨内置词表/官方释义（API 拿不到，D24）；
 * - 只改本地 `states`（+ 记录 `maimemoVocId`），**不造词、不改内置词表**；
 * - 匹配不到的拼写进 `unmatched` 报告，由 UI 提示用户手动加词（D43）；
 * - Token 只从调用方/设置读，绝不硬编码、不写日志、不进导出包。
 */

import type { ImportIssue, ImportReport, ReviewLog, Word, WordState } from '../../core'
import { getDb } from '../db'
import { getSettings } from '../settings.repo'
import { createMaimemoClient, makeMaimemoError } from './maimemo-client'
import { isNativeHttpAvailable } from './native-http'
import type { MaimemoClient } from './maimemo-client'
import type { MatchedWordInfo, RecordMatcher } from './maimemo-mapper'
import { mapStudyRecords, normalizeSpelling } from './maimemo-mapper'
import type { MaimemoImportResult, MaimemoSession, StudyRecord } from './maimemo-types'
import { MAIMEMO_MESSAGES } from './maimemo-types'

export type {
  MaimemoError,
  MaimemoErrorCode,
  MaimemoImportResult,
  MaimemoSession,
  StudyRecord,
} from './maimemo-types'
export { MAIMEMO_MESSAGES, MANUAL_IMPORT_HINT } from './maimemo-types'
export {
  createMaimemoClient,
  MaimemoClient,
  isMaimemoError,
  makeMaimemoError,
  parseMaimemoDate,
  formatMaimemoDate,
} from './maimemo-client'
export {
  isNativeHttpAvailable,
  nativeFetch,
  cancelAllNativeRequests,
  NATIVE_HTTP_TIMEOUT_MS,
} from './native-http'
export type { MomoApiBridge, MomoApiBridgeResult } from './native-http'

/** 内存态会话（token 持久化在 settings，不在这里） */
let memorySession: MaimemoSession = { token: '', proxyUrl: '' }

/** 设置本次导入用的 token/proxy（token 建议同时写 settings['data.maimemoToken']） */
export function setMaimemoSession(next: Partial<MaimemoSession>): void {
  memorySession = { ...memorySession, ...next }
}

/** 读取当前内存态会话（不读 settings；调用方自行决定是否持久化） */
export function getMaimemoSession(): MaimemoSession {
  return { ...memorySession }
}

/** 从设置里解析导入参数（token/proxy 优先级：显式参数 > 内存会话 > settings 本机存储） */
async function resolveCredentials(opts: { token?: string; proxyUrl?: string } = {}): Promise<{
  token: string
  proxyUrl: string
}> {
  const settings = await getSettings()
  const token = (opts.token ?? memorySession.token ?? settings['data.maimemoToken'] ?? '').trim()
  const proxyUrl = (opts.proxyUrl ?? memorySession.proxyUrl ?? settings['data.proxyUrl'] ?? '').trim()
  return { token, proxyUrl }
}

/**
 * 解析「手动粘贴 JSON」文本：接受
 * `[...records]`、`{records:[...]}`、`{data:{records:[...]}}`、`{data:[...]}`。
 */
export function parseMaimemoRecordsJson(text: string): unknown[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw makeMaimemoError(
      'E_BAD_INPUT',
      `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (Array.isArray(object.records)) return object.records
    if (object.data && typeof object.data === 'object') {
      const data = object.data as Record<string, unknown>
      if (Array.isArray(data.records)) return data.records
      if (Array.isArray(object.data)) return object.data
    }
    if (Array.isArray(object.data)) return object.data
  }
  throw makeMaimemoError(
    'E_BAD_INPUT',
    '没有找到学习记录数组（支持 [{...}] 或 {"records":[{...}]}）',
  )
}

/** 分批写（手机端 bulkPut 500 条更稳） */
async function bulkPutChunked<T>(
  table: { bulkPut: (items: T[]) => Promise<unknown> },
  items: T[],
): Promise<void> {
  const CHUNK = 500
  for (let i = 0; i < items.length; i += CHUNK) {
    await table.bulkPut(items.slice(i, i + CHUNK))
  }
}

interface MatcherBundle {
  matcher: RecordMatcher
  /** normalized spelling → 本地词条（用于回写 voc_id） */
  wordBySpelling: Map<string, Word>
}

/**
 * 用本地词库构建匹配器。
 * 同一拼写可能出现在多个词库：**当前在学词库 > 默认词库 > 其它**（同优先级按 deckId 排序）。
 */
async function buildMatcher(records: readonly unknown[]): Promise<MatcherBundle> {
  const db = getDb()
  const spellings = [
    ...new Set(
      records
        .map((record) => normalizeSpelling((record as StudyRecord | null)?.voc_spelling))
        .filter(Boolean),
    ),
  ]
  const found: Word[] = []
  const CHUNK = 200
  for (let i = 0; i < spellings.length; i += CHUNK) {
    const chunk = spellings.slice(i, i + CHUNK)
    const rows = await db.words.where('headwordLower').anyOf(chunk).toArray()
    found.push(...rows)
  }

  const settings = await getSettings()
  const selectedDeckId = settings['data.selectedDeckId']
  const decks = await db.decks.toArray()
  const deckPriority = new Map<string, number>()
  for (const deck of decks) {
    if (deck.id === selectedDeckId) deckPriority.set(deck.id, 0)
    else if (deck.isDefault) deckPriority.set(deck.id, 1)
    else deckPriority.set(deck.id, 2)
  }

  const grouped = new Map<string, Word[]>()
  for (const word of found) {
    const list = grouped.get(word.headwordLower) ?? []
    list.push(word)
    grouped.set(word.headwordLower, list)
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      const pa = deckPriority.get(a.deckId) ?? 2
      const pb = deckPriority.get(b.deckId) ?? 2
      if (pa !== pb) return pa - pb
      return a.deckId < b.deckId ? -1 : a.deckId > b.deckId ? 1 : 0
    })
  }

  const wordBySpelling = new Map<string, Word>()
  for (const [spelling, list] of grouped) {
    const first = list[0]
    if (first) wordBySpelling.set(spelling, first)
  }

  const matcher: RecordMatcher = (spelling) => {
    const word = wordBySpelling.get(spelling)
    if (!word) return null
    const info: MatchedWordInfo = {
      wordId: word.id,
      deckId: word.deckId,
      meaningIds: word.meanings.map((meaning) => meaning.id),
      spelling: word.headword,
    }
    return info
  }
  return { matcher, wordBySpelling }
}

/** 写 `meta:import:last`（设置页展示上次导入结果） */
async function recordLastImport(result: MaimemoImportResult): Promise<void> {
  try {
    const db = getDb()
    const reviewLogs: ReviewLog[] = []
    const report: ImportReport = {
      ok: result.ok,
      kind: 'maimemo',
      counts: {
        decks: 0,
        words: 0,
        states: result.matched,
        reviewLogs: reviewLogs.length,
        skipped: result.skipped + result.unmatchedCount,
      },
      issues: result.issues,
      durationMs: result.durationMs,
    }
    await db.meta.put({
      key: 'import:last',
      value: { at: result.importedAt, kind: 'maimemo', report },
      updatedAt: result.importedAt,
    })
  } catch {
    // 记录导入历史失败不影响主流程
  }
}

/**
 * 把墨墨学习记录写成本地学习状态（**纯本地，不联网**）。
 * 手动粘贴 JSON 与 API 自动导入共用这条路径（SPEC §7.3 手动降级）。
 */
export async function importMaimemoRecords(records: unknown[]): Promise<MaimemoImportResult> {
  const startedAt = Date.now()
  if (!Array.isArray(records)) {
    throw makeMaimemoError('E_BAD_INPUT', '学习记录必须是数组')
  }
  const { matcher, wordBySpelling } = await buildMatcher(records)
  const mapped = mapStudyRecords(records, matcher, startedAt)
  const db = getDb()
  const now = Date.now()

  // 记录 voc_id（仅本机参考；不覆盖已有值）
  const vocIdByWordId = new Map<string, string>()
  const wordUpdates: Word[] = []
  for (const raw of records) {
    const record = raw as StudyRecord
    const spelling = normalizeSpelling(record?.voc_spelling)
    if (!spelling || !record?.voc_id) continue
    const word = wordBySpelling.get(spelling)
    if (!word || word.maimemoVocId) continue
    if (!vocIdByWordId.has(word.id)) {
      vocIdByWordId.set(word.id, String(record.voc_id))
      wordUpdates.push({ ...word, maimemoVocId: String(record.voc_id) })
    }
  }

  const result: MaimemoImportResult = {
    ok: true,
    matched: mapped.matched,
    unmatched: mapped.unmatched,
    unmatchedCount: mapped.unmatchedCount,
    skipped: mapped.skipped,
    totalRecords: records.length,
    pages: 0,
    issues: mapped.issues,
    durationMs: Date.now() - startedAt,
    importedAt: now,
  }

  await db.transaction('rw', db.states, db.words, db.meta, async () => {
    await bulkPutChunked(db.states, mapped.states)
    if (wordUpdates.length > 0) await bulkPutChunked(db.words, wordUpdates)
  })
  await recordLastImport(result)
  return result
}

/**
 * 收集本地词库的拼写列表（按归一化 headword 去重，保留原拼写）。
 * task-40：作为 `spellings` 批量查询的输入（受限商业词表+大纲合计约 6700 唯一拼写 → 14 批 ×500）。
 */
async function collectLocalSpellings(): Promise<string[]> {
  const db = getDb()
  const words = await db.words.toArray()
  const seen = new Set<string>()
  const spellings: string[] = []
  for (const word of words) {
    const key = normalizeSpelling(word.headword)
    if (!key || seen.has(key)) continue
    seen.add(key)
    spellings.push(word.headword)
  }
  return spellings
}

/**
 * 用 Token（可选本地代理）拉全量学习记录并导入。
 *
 * - Token 来源：参数 > `setMaimemoSession()` > `settings['data.maimemoToken']`（只存本机）；
 * - 代理：参数 > 内存会话 > `settings['data.proxyUrl']`（浏览器直连会被 CORS 拦）；
 * - 分页/节流/退避在 `MaimemoClient.fetchAllStudyRecords()` 内（D45）；
 * - 失败抛 `MaimemoError`（code 供 UI 显示 `MAIMEMO_MESSAGES`）。
 */
export async function importMaimemoProgress(opts: {
  token?: string
  proxyUrl?: string
  /** 进度：已扫描词数 / 总词数（task-40 语义） */
  onProgress?: (scanned: number, total: number) => void
  /** 取消（页面退出/用户中止） */
  signal?: AbortSignal
  /** 每批拼写数（默认 500） */
  batchSize?: number
  /** 批间最小间隔 ms（默认 3200；实测 1.6–2.6s 会被限流） */
  minIntervalMs?: number
  /** 测试注入（本地单测不碰真实网络） */
  client?: MaimemoClient
} = {}): Promise<MaimemoImportResult> {
  const startedAt = Date.now()
  const { token, proxyUrl } = await resolveCredentials(opts)
  let client = opts.client
  if (!client) {
    if (!token) {
      throw makeMaimemoError(
        'E_NO_TOKEN',
        '未配置墨墨 Token（App → 我的 → 更多设置 → 实验功能 → 开放 API）',
      )
    }
    client = createMaimemoClient({ token, proxyUrl })
  }
  // task-40：优先按本地词库拼写批量查询（日期窗口分页不可靠）
  const spellings = await collectLocalSpellings()
  const fetched = await client.fetchAllStudyRecords({
    spellings,
    signal: opts.signal,
    onProgress: opts.onProgress,
    batchSize: opts.batchSize,
    minIntervalMs: opts.minIntervalMs,
  })
  if (fetched.records.length === 0) {
    return {
      ok: true,
      matched: 0,
      unmatched: [],
      unmatchedCount: 0,
      skipped: 0,
      totalRecords: 0,
      pages: fetched.pages,
      issues: [
        {
          level: 'warning',
          code: 'W_SKIPPED',
          message: '墨墨没有返回任何学习记录（可能还没开始学习，或学习数据接口未同步）',
        },
      ],
      durationMs: Date.now() - startedAt,
      importedAt: Date.now(),
    }
  }
  const result = await importMaimemoRecords(fetched.records)
  return {
    ...result,
    pages: fetched.pages,
    totalRecords: fetched.records.length + result.skipped,
    strategy: fetched.strategy,
    scanned: fetched.scanned,
    durationMs: Date.now() - startedAt,
  }
}

/** 纯映射（不写库）：给定记录 → WordState[]（QA/调试用） */
export async function mapStudyRecordsToStates(records: unknown[]): Promise<{
  states: WordState[]
  matched: number
  unmatched: string[]
  unmatchedCount: number
  skipped: number
  issues: ImportIssue[]
}> {
  const { matcher } = await buildMatcher(records)
  return mapStudyRecords(records, matcher, Date.now())
}

/**
 * 测试连接（设置页「检测 Token 是否可用」）：只发 1 个轻量请求，返回今日进度。
 * 不写库、不改状态；失败抛 MaimemoError（UI 用 MAIMEMO_MESSAGES 展示）。
 */
export async function probeMaimemoToken(opts: { token?: string; proxyUrl?: string } = {}): Promise<{
  ok: true
  finished: number
  total: number
  studyTime: number
}> {
  const { token, proxyUrl } = await resolveCredentials(opts)
  if (!token) throw makeMaimemoError('E_NO_TOKEN', '未配置墨墨 Token')
  const client = createMaimemoClient({ token, proxyUrl })
  const progress = await client.getStudyProgress()
  return { ok: true, ...progress }
}

/**
 * 按运行环境取错误文案（task-38）：
 * - APK 原生直连（`isNativeHttpAvailable()`）时，网络类错误**不提示配置代理/CORS**，
 *   改为「网络失败，请检查网络或 Token」；
 * - 浏览器/PWA 保持 `MAIMEMO_MESSAGES` 的代理提示。
 * UI 直接用本函数替代 `MAIMEMO_MESSAGES[code]`。
 */
/** 单个错误码的文案（按环境自动调整；推荐 UI 使用） */
export function maimemoMessageFor(code: import('./maimemo-types').MaimemoErrorCode): {
  title: string
  hint: string
  action?: string
} {
  const base = MAIMEMO_MESSAGES[code]
  if (isNativeHttpAvailable() && (code === 'E_NETWORK' || code === 'E_CORS')) {
    return {
      title: '网络失败',
      hint: '请检查网络连接或墨墨 Token（APK 内置直连，无需额外设置）',
      action: '重试',
    }
  }
  return base
}
