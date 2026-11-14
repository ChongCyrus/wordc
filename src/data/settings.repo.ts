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
import { BRAND } from '../app/brand'

/** = 合并默认值后的完整设置对象（§9.3 契约） */
export type AppSettings = SettingsMap

export type SettingValue = SettingsMap[SettingKey]

/** 设置项默认值（SPEC §5 表，逐字） */
export const SETTINGS_DEFAULTS: AppSettings = {
  'study.dailyGoal': 30,
  'study.recallMode': 'en2cn',
  // task-27（官方前端行为）：新词首次显示「认识/不确定/不认识」，之后「认识/模糊/忘记」
  'study.labelSwitch': true,
  // 官方默认不允许「模糊完成复习」（模糊持续到认识）
  'study.allowVagueComplete': false,
  // task-47（用户拍板）：新词顺序默认随机打乱（用 plan 稳定种子，退出重进/改学习量顺序不变）
  'study.newWordOrder': 'random',
  // task-51：每日自动入队的到期复习上限；0=不限（默认，官方语义），1–9999 生效
  'study.dailyReviewCap': 0,
  'board.exampleCount': 2,
  'board.showPhonetic': true,
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
  // task-58：默认在学词库由品牌配置决定（私版受限商业词表 / 公开版大纲）
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
  'study.recallMode': { kind: 'enum', values: ['en2cn'] },
  'study.labelSwitch': { kind: 'boolean' },
  'study.allowVagueComplete': { kind: 'boolean' },
  'study.newWordOrder': { kind: 'enum', values: ['order', 'random'] },
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
  const db = getDb()
  return db.settings.toArray()
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
  const db = getDb()
  const row = await db.settings.get(key)
  return row ? settingOrDefault(key, row.value) : SETTINGS_DEFAULTS[key]
}

/**
 * 更新设置（部分更新；每个 key 校验 + clamp 后写库）。
 * - 未知 key → throw（程序错误，早点暴露）
 * - 非法值 → throw（UI 应该提供合法控件；导入路径用 normalize 静默兜底）
 * - `data.selectedDeckId` 非空时必须指向存在的词库，否则 throw
 */
export async function updateSettings(patch: Partial<SettingsMap>): Promise<AppSettings> {
  const db = getDb()
  const now = Date.now()
  const entries = Object.entries(patch) as Array<[string, unknown]>
  const rows: SettingRecord[] = []
  for (const [key, rawValue] of entries) {
    if (!isSettingKey(key)) throw new Error(`未知设置项：${key}`)
    if (rawValue === undefined) continue
    const value = normalizeSettingValue(key, rawValue)
    if (value === undefined) throw new Error(`设置项 ${key} 的值不合法：${String(rawValue)}`)
    if (key === 'data.selectedDeckId' && value) {
      const deck = await db.decks.get(value as string)
      if (!deck) throw new Error(`词库不存在：${String(value)}`)
    }
    rows.push({ key, value, updatedAt: now } as SettingRecord)
  }
  if (rows.length > 0) {
    await db.settings.bulkPut(rows)
  }
  return getSettings()
}

/** 恢复默认设置（删除全部 settings 行；token 也一起清，需要保留请显式重写） */
export async function resetSettings(): Promise<AppSettings> {
  const db = getDb()
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
  if (rows.length > 0) await db.settings.bulkPut(rows)
  return getSettings()
}
