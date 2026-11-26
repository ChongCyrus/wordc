/**
 * 设置读写（SPEC §5 / D48，15 个 key）。
 *
 * 约定：
 * - 存储：settings 表 `{key, value, updatedAt}`；读时与默认值合并（缺失/越界都用默认值兜底）。
 * - **越界值 clamp 后写回**（§5 表头）；key 一旦发布不可改名。
 * - `data.maimemoToken` 只存本机：不写日志、不进迁移包（import-export 里过滤）。
 * - `data.selectedDeckId` 必须是存在的词库 id（写时校验；读时不因词库被删而报错）。
 */

import type { SettingKey, SettingRecord, SettingsMap } from '../core'
import { getDb } from './db'
import { readSettingsThroughCache } from './sqlite-read'
import { isSqliteAvailable, sqliteHealth, sqliteQuery, sqliteTx } from './native-sqlite'
import { getIdbCacheMeta, markIdbCacheDirty } from './idb-cache'
import { SQLITE_SCHEMA_VERSION, extractSqliteCounts, getIdbFactCounts } from './sqlite-store'
import { BRAND } from '../app/brand'

/** = 合并默认值后的完整设置对象（§9.3 契约） */
export type AppSettings = SettingsMap

export type SettingValue = SettingsMap[SettingKey]

/** 设置项默认值（SPEC §5 表，逐字） */
/** 私版构建（VITE_PRIVATE_PACKS=1）默认开启预生成内容自动预装；公开版关闭 */
function isPrivateGeneratedAutoSeed(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { VITE_PRIVATE_PACKS?: string } }).env
    return env?.VITE_PRIVATE_PACKS === '1'
  } catch {
    return false
  }
}

export const SETTINGS_DEFAULTS: AppSettings = {
  'study.dailyGoal': 30,
  // 0.3.86：每日自动备份（APK 静默；Web 仅提示）
  'data.autoBackupEnabled': true,
  // 0.3.87：新词来源（默认 manual=用户添加；auto=旧自动排新词）
  'study.newWordSource': 'manual',
  // 0.3.91：添词默认方式/数量
  'study.addWordMode': 'manual',
  'study.addWordCount': 20,
  // 0.16.2：私版构建（VITE_PRIVATE_PACKS=1）默认自动预装预生成内容（本义助记/词根缀源/引申图）；
  // 公开版仍保持 false，避免首启卡与体积膨胀。
  'data.generatedAutoSeed': isPrivateGeneratedAutoSeed(),
  'backup.autoContentEnabled': false,
  'backup.contentEventLogEnabled': true,
  'data.contentWriteSource': 'idb',
  // 0.3.98：默认显示词根词缀词源分解
  'study.showRootEtymology': true,
  'study.rootAffixCardStyle': 'compact',
  // 0.8.0：默认关闭「只记词根缀」
  'memory.rootAffixOnly': false,
  'study.recallMode': 'en2cn',
  // task-27（官方前端行为）：新词首次显示「认识/不确定/不认识」，之后「认识/模糊/忘记」
  'study.labelSwitch': true,
  // 官方默认不允许「模糊完成复习」（模糊持续到认识）
  'study.allowVagueComplete': false,
  // task-47（用户拍板）：新词顺序默认随机打乱（用 plan 稳定种子，退出重进/改学习量顺序不变）
  'study.newWordOrder': 'random',
  // task-51：每日自动入队的到期复习上限；0=不限（默认，官方语义），1–9999 生效
  'study.dailyReviewCap': 0,
  // 0.3.61：记忆/加权记忆是否隐藏「不常考」含义（注释面仍全显示）
  'study.hideRareMeanings': true,
  // 0.3.69：AI 批量标记不常考时是否也标记不常考本义（默认开）
  'study.markRareCoreSenses': true,
  // 0.3.69：注释面/生成式阶段3 默认隐藏不常考块（不影响记忆/加权记忆）
  'study.hideRareBlocks': true,
  // 0.3.70：加权记忆「只记本义」模式（默认关）
  'memory.weightedCoreSenseOnly': false,
  // 0.3.72：只记本义页本义例句数量 0–3（默认 2）
  'memory.coreSenseExampleCount': 2,
  // 0.3.72：只记本义页本义词组数量 0–3（默认 2）
  'memory.coreSensePhraseCount': 2,
  // 0.3.80：记忆三小次（full→hidden→full 才 +1；旧库缺键按 true）
  'memory.threeTapRecall': true,
  // 0.3.85：第3拍后卡片闪动刷新动画（默认关闭；旧库缺省 false）
  'memory.cardFlashAnimation': false,
  'board.exampleCount': 2,
  'board.showPhonetic': true,
  'board.showMeaningPhrases': false,
  // F10：引申图文字支持轻量 Markdown 渲染（默认开）
  'derivation.markdown': true,
  // task-187：右页滑动手势灵敏度（1=1:1；0.2–3.0）
  'derivation.swipeSensitivity': 1,
  'memory.totalRepeats': 3,
  'memory.weightedMin': 1,
  'memory.weightedMax': 10,
  'memory.weightedK': 1,
  'memory.mode': 'sequential',
  'memory.showPhrases': true,
  // 三键是否显示「N 天后 / 今日进度」（官方「预计复习间隔」开关）
  'memory.showPredictedInterval': true,
  'memory.fontScale': 1,
  'memory.cardSize': 1,
  'app.fontScale': 1,
  'app.theme': 'system',
  'app.reduceMotion': false,
  'data.maimemoToken': '',
  'data.proxyUrl': 'http://127.0.0.1:8787',
  // task-58：默认在学词库由品牌配置决定（私版商业词表 / 公开版大纲）
  'data.selectedDeckId': BRAND.defaultDeckId,
  // —— AI 内容生成（task-70；默认关，避免误调用）——
  'ai.enabled': false,
  'ai.provider': 'deepseek',
  'ai.baseUrl': 'https://api.deepseek.com',
  'ai.model': 'deepseek-chat',
  // ⚠️ 敏感：仅本机；导出/迁移包过滤，不进日志
  'ai.apiKey': '',
  'ai.keyStorage': 'persistent',
  'ai.transport': 'auto',
  'ai.batchSize': 20,
  'ai.maxCostPerRun': 3,
  'ai.pregenBudget': 40,
  // task-80：是否发送 response_format:{type:'json_object'}（部分免费/兼容模型不支持；默认开）
  'ai.jsonMode': true,
}

/** §5 / D48 的 15 个 key（顺序即设置页展示顺序） */
export const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS) as SettingKey[]

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, value)
}

// ============ 校验 / clamp 规则 ============

interface NumberRule {
  kind: 'number'
  min: number
  max: number
  /** 步长（0.05 等），缺省 1（整数） */
  step: number
  /** true = 越界直接判非法（不 clamp）；用于必须精确取值的项（如 dailyGoal） */
  rejectOutOfRange?: boolean
  /** true = 必须是整数（小数判非法，不四舍五入） */
  rejectNonInteger?: boolean
  /** true = 只接受 number 类型（数字字符串也判非法） */
  strictType?: boolean
}

interface EnumRule {
  kind: 'enum'
  values: readonly string[]
}

interface BooleanRule {
  kind: 'boolean'
}

interface StringRule {
  kind: 'string'
  maxLength?: number
  /** 为 true 时允许空串 */
  allowEmpty?: boolean
  pattern?: RegExp
}

type Rule = NumberRule | EnumRule | BooleanRule | StringRule

const RULES: Record<SettingKey, Rule> = {
  'study.dailyGoal': {
    kind: 'number',
    min: 1,
    max: 9999,
    step: 1,
    rejectOutOfRange: true,
    rejectNonInteger: true,
    strictType: true,
  },
  'data.autoBackupEnabled': { kind: 'boolean' },
  'study.newWordSource': { kind: 'enum', values: ['manual', 'auto'] },
  'data.contentWriteSource': { kind: 'enum', values: ['idb', 'sqlite'] },
  'study.addWordMode': { kind: 'enum', values: ['manual', 'random', 'order'] },
  'study.addWordCount': { kind: 'number', min: 1, max: 999, step: 1 },
  'data.generatedAutoSeed': { kind: 'boolean' },
  'backup.autoContentEnabled': { kind: 'boolean' },
  'backup.contentEventLogEnabled': { kind: 'boolean' },
  'study.showRootEtymology': { kind: 'boolean' },
  'study.rootAffixCardStyle': { kind: 'enum', values: ['compact', 'standard'] },
  'memory.rootAffixOnly': { kind: 'boolean' },
  'study.recallMode': { kind: 'enum', values: ['en2cn'] },
  'study.labelSwitch': { kind: 'boolean' },
  'study.allowVagueComplete': { kind: 'boolean' },
  'study.newWordOrder': { kind: 'enum', values: ['order', 'random'] },
  'study.hideRareMeanings': { kind: 'boolean' },
  'study.markRareCoreSenses': { kind: 'boolean' },
  'study.hideRareBlocks': { kind: 'boolean' },
  'memory.weightedCoreSenseOnly': { kind: 'boolean' },
  'memory.coreSenseExampleCount': { kind: 'number', min: 0, max: 3, step: 1 },
  'memory.coreSensePhraseCount': { kind: 'number', min: 0, max: 3, step: 1 },
  'memory.threeTapRecall': { kind: 'boolean' },
  'memory.cardFlashAnimation': { kind: 'boolean' },
  'study.dailyReviewCap': {
    kind: 'number',
    min: 0,
    max: 9999,
    step: 1,
    rejectOutOfRange: true,
    rejectNonInteger: true,
    strictType: true,
  },
  'board.exampleCount': { kind: 'number', min: 0, max: 3, step: 1 },
  'board.showPhonetic': { kind: 'boolean' },
  'board.showMeaningPhrases': { kind: 'boolean' },
  'derivation.markdown': { kind: 'boolean' },
  'derivation.swipeSensitivity': { kind: 'number', min: 0.2, max: 3, step: 0.1 },
  'memory.totalRepeats': { kind: 'number', min: 1, max: 10, step: 1 },
  'memory.weightedMin': { kind: 'number', min: 1, max: 10, step: 1 },
  'memory.weightedMax': { kind: 'number', min: 1, max: 20, step: 1 },
  'memory.weightedK': { kind: 'number', min: 0, max: 2, step: 0.1 },
  'memory.mode': { kind: 'enum', values: ['sequential', 'random'] },
  'memory.showPhrases': { kind: 'boolean' },
  'memory.showPredictedInterval': { kind: 'boolean' },
  'memory.fontScale': { kind: 'number', min: 0.8, max: 1.6, step: 0.05 },
  'memory.cardSize': { kind: 'number', min: 0.8, max: 1.4, step: 0.05 },
  'app.fontScale': { kind: 'number', min: 0.9, max: 1.2, step: 0.05 },
  'app.theme': { kind: 'enum', values: ['system', 'light', 'dark'] },
  'app.reduceMotion': { kind: 'boolean' },
  'data.maimemoToken': { kind: 'string', maxLength: 2048, allowEmpty: true },
  'data.proxyUrl': { kind: 'string', maxLength: 512, allowEmpty: true, pattern: /^https?:\/\/\S+$/i },
  'data.selectedDeckId': { kind: 'string', maxLength: 128, allowEmpty: true },
  'ai.enabled': { kind: 'boolean' },
  'ai.provider': { kind: 'enum', values: ['deepseek', 'openai-compatible'] },
  'ai.baseUrl': {
    kind: 'string',
    maxLength: 2048,
    allowEmpty: true,
    pattern: /^https?:\/\/\S+$/i,
  },
  'ai.model': { kind: 'string', maxLength: 200 },
  // 敏感项：允许空串（清空 Key）
  'ai.apiKey': { kind: 'string', maxLength: 2048, allowEmpty: true },
  'ai.keyStorage': { kind: 'enum', values: ['persistent', 'session'] },
  'ai.transport': { kind: 'enum', values: ['auto', 'proxy', 'native'] },
  'ai.batchSize': {
    kind: 'number',
    min: 1,
    max: 50,
    step: 1,
    rejectOutOfRange: true,
    rejectNonInteger: true,
    strictType: true,
  },
  'ai.maxCostPerRun': {
    kind: 'number',
    min: 0,
    max: 1000,
    step: 1,
    rejectOutOfRange: true,
    rejectNonInteger: true,
    strictType: true,
  },
  'ai.pregenBudget': {
    kind: 'number',
    min: 0,
    max: 10000,
    step: 1,
    rejectOutOfRange: true,
    rejectNonInteger: true,
    strictType: true,
  },
  'ai.jsonMode': { kind: 'boolean' },
}

function roundStep(value: number, step: number): number {
  const rounded = Math.round(value / step) * step
  // 修掉 0.05 步长的浮点尾巴（如 1.0000000000000002）
  return Math.round(rounded * 1000) / 1000
}

/**
 * 归一化某个设置值：合法 → 返回 clamp/规范化后的值；非法 → undefined（调用方用默认值兜底）。
 * 注意：字符串型 key 的「存在性/URL」等业务校验不在这里（见 updateSettings）。
 */
export function normalizeSettingValue<K extends SettingKey>(
  key: K,
  raw: unknown,
): SettingsMap[K] | undefined {
  const rule = RULES[key]
  switch (rule.kind) {
    case 'number': {
      if (rule.strictType && typeof raw !== 'number') return undefined
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(num)) return undefined
      if (rule.rejectNonInteger && !Number.isInteger(num)) return undefined
      if (rule.rejectOutOfRange && (num < rule.min || num > rule.max)) return undefined
      const clamped = Math.min(rule.max, Math.max(rule.min, num))
      return roundStep(clamped, rule.step) as SettingsMap[K]
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw as SettingsMap[K]
      if (raw === 'true') return true as SettingsMap[K]
      if (raw === 'false') return false as SettingsMap[K]
      return undefined
    }
    case 'enum': {
      if (typeof raw !== 'string' || !rule.values.includes(raw)) return undefined
      return raw as SettingsMap[K]
    }
    case 'string': {
      if (typeof raw !== 'string') return undefined
      let value = raw.trim()
      if (key === 'data.maimemoToken') value = raw.trim() // token 不 trim 中间
      if (!value && !rule.allowEmpty) return undefined
      if (rule.maxLength != null && value.length > rule.maxLength) {
        if (!rule.allowEmpty) return undefined
        value = value.slice(0, rule.maxLength)
      }
      if (value && rule.pattern && !rule.pattern.test(value)) return undefined
      return value as SettingsMap[K]
    }
    default:
      return undefined
  }
}

/** 单值规范化（不合法时返回默认值；读库兜底用） */
export function settingOrDefault<K extends SettingKey>(key: K, raw: unknown): SettingsMap[K] {
  const normalized = normalizeSettingValue(key, raw)
  return normalized === undefined ? SETTINGS_DEFAULTS[key] : normalized
}

// ============ 读写 API ============

async function readRows(): Promise<SettingRecord[]> {
  return readSettingsThroughCache()
}

/** 读取完整设置（默认值合并 + 逐项校验兜底） */
export async function getSettings(): Promise<AppSettings> {
  const rows = await readRows()
  const settings: AppSettings = { ...SETTINGS_DEFAULTS }
  for (const row of rows) {
    if (!isSettingKey(row?.key)) continue
    const normalized = normalizeSettingValue(row.key, row.value)
    if (normalized !== undefined) {
      // 逐 key 赋值（TS 对 union 的索引写入不友好，这里运行时安全）
      ;(settings as Record<string, unknown>)[row.key] = normalized
    }
  }
  return settings
}

/** 读取单个设置项（带默认值） */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
  // M4b-1：sqlite 模式 dirty/cache 失败时不能直接读旧 IDB；统一走 getSettings 的 readThrough
  const settings = await getSettings()
  return settings[key] ?? SETTINGS_DEFAULTS[key]
}

/**
 * 更新设置（部分更新；每个 key 校验 + clamp 后写库）。
 * - 未知 key → throw（程序错误，早点暴露）
 * - 非法值 → throw（UI 应该提供合法控件；导入路径用 normalize 静默兜底）
 * - `data.selectedDeckId` 非空时必须指向存在的词库，否则 throw
 */
export type SettingsWriteMode = 'idb' | 'sqlite'
let settingsWriteMode: SettingsWriteMode = 'idb'
let settingsCheckpointScheduler: (() => void) | null = null

/** M4b-1 测试/切换用；生产由 enableSettingsSqliteWrite 通过门禁后设置 */
export function setSettingsWriteMode(mode: SettingsWriteMode): void {
  settingsWriteMode = mode
}
export function getSettingsWriteMode(): SettingsWriteMode {
  return settingsWriteMode
}

export const SETTINGS_WRITE_SOURCE_KEY = 'data.writeSource'

/** 持久化写源（settings/meta），重启后由 restoreSettingsWriteMode 恢复 */
export async function persistSettingsWriteMode(mode: SettingsWriteMode): Promise<void> {
  settingsWriteMode = mode
  await getDb().meta.put({
    key: SETTINGS_WRITE_SOURCE_KEY,
    value: { source: mode, enabledAt: Date.now(), schemaVersion: SQLITE_SCHEMA_VERSION },
    updatedAt: Date.now(),
  })
}

/** 启动门禁后调用：meta 标记 sqlite 且 SQLite v2 可用才恢复；失败自动回 IDB 并写 diag */
export async function restoreSettingsWriteMode(): Promise<SettingsWriteMode> {
  const db = getDb()
  const row = await db.meta.get(SETTINGS_WRITE_SOURCE_KEY)
  const value = row?.value as { source?: string } | string | undefined
  const wanted = typeof value === 'string' ? value : value?.source
  if (wanted !== 'sqlite') {
    settingsWriteMode = 'idb'
    return settingsWriteMode
  }
  try {
    if (!isSqliteAvailable()) throw new Error('SQLite bridge 不可用')
    const health = await sqliteHealth(30_000)
    if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) throw new Error(`schema=${String(health.userVersion ?? 0)}`)
    const cache = await getIdbCacheMeta()
    if (!cache || cache.dirty || cache.sqliteUserVersion !== SQLITE_SCHEMA_VERSION) throw new Error('IDB cache 未就绪')
    settingsWriteMode = 'sqlite'
  } catch (error) {
    settingsWriteMode = 'idb'
    await db.meta.put({
      key: 'settingsWrite.diag',
      value: { at: Date.now(), error: error instanceof Error ? error.message : String(error) },
      updatedAt: Date.now(),
    }).catch(() => undefined)
  }
  return settingsWriteMode
}
/** M4b-1：settings 成功后触发检查点（app 注入 scheduleStateCheckpoint(bridge)） */
export function setSettingsCheckpointScheduler(fn: (() => void) | null): void {
  settingsCheckpointScheduler = fn
}

function buildSettingRows(patch: Partial<SettingsMap>, now: number): Array<[string, unknown, SettingRecord]> {
  const entries = Object.entries(patch) as Array<[string, unknown]>
  const rows: Array<[string, unknown, SettingRecord]> = []
  for (const [key, rawValue] of entries) {
    if (!isSettingKey(key)) throw new Error(`未知设置项：${key}`)
    if (rawValue === undefined) continue
    const value = normalizeSettingValue(key, rawValue)
    if (value === undefined) throw new Error(`设置项 ${key} 的值不合法：${String(rawValue)}`)
    rows.push([key, value, { key, value, updatedAt: now } as SettingRecord])
  }
  return rows
}

async function validateSeletedDeck(rows: Array<[string, unknown, SettingRecord]>): Promise<void> {
  const db = getDb()
  for (const [key, value] of rows) {
    if (key === 'data.selectedDeckId' && value) {
      const deck = await db.decks.get(value as string)
      if (!deck) throw new Error(`词库不存在：${String(value)}`)
    }
  }
}

function notifySettingsUpdated(keys: readonly string[]): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('momo:settings-updated', { detail: { keys } }))
  } catch {
    /* ignore */
  }
}

async function cacheRowsAfterSqlite(rows: SettingRecord[]): Promise<void> {
  if (rows.length === 0) return
  try {
    await getDb().settings.bulkPut(rows)
  } catch {
    await markIdbCacheDirty('settings-cache-write-failed').catch(() => undefined)
  }
}

async function writeSettingsRowsSqlite(rows: SettingRecord[], now: number): Promise<void> {
  if (rows.length === 0) return
  const response = await sqliteTx(
    rows.map((row) => ({
      op: 'upsert',
      table: 'settings',
      row: { key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt ?? now },
    })),
  )
  if (response.ok === false) throw new Error(response.message ?? 'settings SQLite 写入失败')
}

export async function updateSettings(patch: Partial<SettingsMap>, opts: { allowContentWriteSource?: boolean } = {}): Promise<AppSettings> {
  if ('data.contentWriteSource' in patch && opts.allowContentWriteSource !== true) throw new Error('data.contentWriteSource 只能通过 switchContentWriteSource 切换')
  const db = getDb()
  const now = Date.now()
  const built = buildSettingRows(patch, now)
  await validateSeletedDeck(built)
  const rows = built.map(([, , row]) => row)
  if (settingsWriteMode === 'sqlite' && isSqliteAvailable()) {
    await writeSettingsRowsSqlite(rows, now)
    await cacheRowsAfterSqlite(rows)
    notifySettingsUpdated(rows.map((row) => row.key))
    settingsCheckpointScheduler?.()
    try {
      return await getSettings()
    } catch {
      const fallbackRows = await db.settings.toArray()
      const fallback: AppSettings = { ...SETTINGS_DEFAULTS }
      for (const row of fallbackRows) {
        if (!isSettingKey(row?.key)) continue
        const normalized = normalizeSettingValue(row.key, row.value)
        if (normalized !== undefined) (fallback as Record<string, unknown>)[row.key] = normalized
      }
      return fallback
    }
  }
  if (rows.length > 0) await db.settings.bulkPut(rows)
  notifySettingsUpdated(rows.map((row) => row.key))
  return getSettings()
}

export interface EnableSettingsSqliteResult {
  ok: boolean
  error?: string
  counts?: { states: number; plans: number; settings: number; reviewLogs: number }
}

/** M4b-1 门禁：备份 + cache/v2 校验后开启 settings SQLite 写；失败保持 IDB 写 */
export async function enableSettingsSqliteWrite(opts: {
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  expectedCounts?: { states: number; plans: number; settings: number; reviewLogs: number }
} = {}): Promise<EnableSettingsSqliteResult> {
  if (!isSqliteAvailable()) return { ok: false, error: '当前环境不支持原生 SQLite' }
  if (opts.preBackup) {
    const backup = await opts.preBackup()
    if (backup && backup.ok === false) return { ok: false, error: `预备份失败，拒绝切换：${backup.error ?? '未知'}` }
  }
  const health = await sqliteHealth(30_000)
  if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) {
    return { ok: false, error: `SQLite schema 不是 v${SQLITE_SCHEMA_VERSION}` }
  }
  const cache = await getIdbCacheMeta()
  if (!cache || cache.dirty || cache.sqliteUserVersion !== SQLITE_SCHEMA_VERSION) {
    return { ok: false, error: 'IDB cache 未就绪/dirty/版本不一致，拒绝切 settings 写' }
  }
  const counts = extractSqliteCounts(health as never)
  if (!counts) return { ok: false, error: 'health 缺少 counts，拒绝切 settings 写' }
  const idbCounts = await getIdbFactCounts()
  const lastIdbSettingsCount = idbCounts.settings
  const same = (a: typeof counts) => a.states === idbCounts.states && a.plans === idbCounts.plans && a.settings === idbCounts.settings && a.reviewLogs === idbCounts.reviewLogs
  if (!same(counts)) return { ok: false, counts, error: 'SQLite counts 与 IDB 不一致，拒绝切 settings 写' }
  if (opts.expectedCounts) {
    const expected = opts.expectedCounts
    // settings key 数会新增；states/plans/reviewLogs 严格，settings 以当前 SQLite/IDB 一致为准（动态）
    if (
      counts.states !== expected.states ||
      counts.plans !== expected.plans ||
      counts.reviewLogs !== expected.reviewLogs ||
      counts.settings < lastIdbSettingsCount
    ) {
      return { ok: false, counts, error: 'SQLite counts 与 expected 不一致，拒绝切 settings 写' }
    }
  }
  await persistSettingsWriteMode('sqlite')
  return { ok: true, counts }
}

/** 恢复默认设置（删除全部 settings 行；token 也一起清，需要保留请显式重写） */
export async function resetSettings(): Promise<AppSettings> {
  const db = getDb()
  if (settingsWriteMode === 'sqlite' && isSqliteAvailable()) {
    // 不能只按 IDB 行删：SQLite 可能有 cache 未覆盖的 key。先查 SQLite keys，失败再回退 IDB。
    let keys: string[] = []
    try {
      const response = await sqliteQuery({ table: 'settings', limit: 1000, offset: 0, orderBy: 'key', direction: 'asc' }, 5_000)
      keys = ((response.rows as Array<Record<string, unknown>> | undefined) ?? []).map((row) => String(row.key))
    } catch {
      keys = (await db.settings.toArray()).map((row) => row.key)
    }
    const response = await sqliteTx(
      keys.map((key) => ({ op: 'delete', table: 'settings', where: { key } })),
    )
    if (response.ok === false) throw new Error(response.message ?? 'settings SQLite 清空失败')
    await db.settings.clear().catch(async () => {
      await markIdbCacheDirty('settings-reset-cache-failed').catch(() => undefined)
    })
    settingsCheckpointScheduler?.()
    return getSettings()
  }
  await db.settings.clear()
  return getSettings()
}

/** 供导入路径用：批量写入（已由调用方确认值合法；未知 key 跳过） */
export async function applyImportedSettings(
  records: ReadonlyArray<{ key: string; value: unknown; updatedAt: number }>,
): Promise<AppSettings> {
  const db = getDb()
  const now = Date.now()
  const rows: SettingRecord[] = []
  for (const record of records) {
    if (!isSettingKey(record.key)) continue
    if (record.key === 'data.maimemoToken') continue // 隐私：迁移包不含 token（D23）
    const value = normalizeSettingValue(record.key, record.value)
    if (value === undefined) continue
    rows.push({
      key: record.key,
      value,
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : now,
    } as SettingRecord)
  }
  if (settingsWriteMode === 'sqlite' && isSqliteAvailable()) {
    await writeSettingsRowsSqlite(rows, now)
    await cacheRowsAfterSqlite(rows)
    settingsCheckpointScheduler?.()
    notifySettingsUpdated(rows.map((row) => row.key))
    return getSettings()
  }
  if (rows.length > 0) await db.settings.bulkPut(rows)
  notifySettingsUpdated(rows.map((row) => row.key))
  return getSettings()
}


export interface RawSettingDiagnostic {
  key: string
  sqlite?: { valueRaw: unknown; valueJsonType: string; updatedAtRaw: unknown } | null
  idb?: { value: unknown; updatedAt: number } | null
}

/** M4b-1 门禁：直接读 SQLite raw settings 与 IDB，不经过归一化/缓存 */
export async function getRawSettingDiagnostics(keys: readonly string[] = ['data.selectedDeckId', 'study.dailyGoal']): Promise<{
  writeMode: SettingsWriteMode
  sqliteAvailable: boolean
  items: RawSettingDiagnostic[]
  cacheMeta?: { generation: number; sqliteUserVersion: number; dirty: boolean; rebuiltAt?: number } | null
  error?: string
}> {
  const db = getDb()
  const { getIdbCacheMeta } = await import('./idb-cache')
  const cacheMeta = await getIdbCacheMeta()
  const idbRows = await db.settings.bulkGet([...keys] as Array<SettingRecord['key']>)
  const idb = new Map<string, SettingRecord>(idbRows.filter(Boolean).map((row) => [String(row!.key), row!]))
  if (!isSqliteAvailable()) {
    return {
      writeMode: settingsWriteMode,
      sqliteAvailable: false,
      items: keys.map((key) => ({ key, idb: idb.has(key) ? { value: idb.get(key)!.value, updatedAt: idb.get(key)!.updatedAt } : null })),
      cacheMeta,
    }
  }
  try {
    const response = await sqliteQuery({ table: 'settings', limit: 1000, offset: 0, orderBy: 'key', direction: 'asc' }, 5_000)
    const map = new Map(((response.rows as Array<Record<string, unknown>> | undefined) ?? []).map((row) => [String(row.key), row]))
    return {
      writeMode: settingsWriteMode,
      sqliteAvailable: true,
      items: keys.map((key) => {
        const row = map.get(key)
        return {
          key,
          sqlite: row
            ? { valueRaw: row.value_json, valueJsonType: typeof row.value_json, updatedAtRaw: row.updated_at }
            : null,
          idb: idb.has(key) ? { value: idb.get(key)!.value, updatedAt: idb.get(key)!.updatedAt } : null,
        }
      }),
      cacheMeta,
    }
  } catch (error) {
    return { writeMode: settingsWriteMode, sqliteAvailable: true, items: [], cacheMeta, error: error instanceof Error ? error.message : String(error) }
  }
}
