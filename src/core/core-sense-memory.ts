/**
 * 本义级不熟悉度 + 「只记本义」加权记忆（task-211，0.3.70）—— **纯函数**。
 *
 * - 本义（coreSenses）与 c（meanings）的不熟悉度统计**完全独立**：各自 clicks/encounters；
 * - 本义 key 用 **JSON 元组** `${JSON.stringify([label.trim(), index])}`，label 可含任意字符（含 `|`），可逆；
 *   解析顺序：exact → label 匹配（本义重排 index 变化仍命中）→ index 兜底（label 重命名保守命中）；
 * - familiarity 复用 `familiarity(clicks, encounters)`（0–1；encounters=0 → null）；
 * - 加权 total 复用 `weightedTotal(base, familiarity, settings)`（memory.weightedMin/Max/K）；
 * - rare 本义（`Word.rareCoreSenses`，label 优先/index 兜底）默认排除；
 * - 会话复用现有 w-c 状态机：把本义单元映射成 pseudo `SessionWord.meanings`，
 *   meaningId 加 **`core:` 前缀**，与真实含义 id 隔离；`weightedTotals` 用同一 pseudo id。
 */

import { familiarity } from './familiarity'
import type { SessionWord } from './session'
import type { MeaningStat, RareCoreSense } from './types'
import {
  DEFAULT_WEIGHTED_MEMORY_SETTINGS,
  weightedTotal,
  type WeightedMemorySettings,
} from './weighted-memory'

/** pseudo meaningId 前缀：避免与真实 c meaningId 冲突（完成本义会话不污染 word.meanings） */
export const CORE_SENSE_MEANING_PREFIX = 'core:'

/** 本义 key：JSON 元组，label 可含 `|`/引号等；可逆 */
export function coreSenseStatKey(index: number, label: string): string {
  return JSON.stringify([label.trim(), index])
}

function parseCoreSenseStatKey(key: string): { label: string; index: number } | null {
  try {
    const parsed = JSON.parse(key) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [label, index] = parsed
    if (typeof label !== 'string' || typeof index !== 'number' || !Number.isInteger(index) || index < 1) {
      return null
    }
    return { label, index }
  } catch {
    return null
  }
}

/**
 * 找某本义对应的 stats key：
 * 1) exact（当前 index+label）→ 2) label 匹配（本义重排）→ 3) index 兜底（label 重命名）。
 * 返回 null 表示该本义尚无统计。
 */
export function resolveCoreSenseStatKey(
  stats: Record<string, MeaningStat> | null | undefined,
  sense: { index: number; label: string },
): string | null {
  if (!stats) return null
  const label = String(sense.label ?? '').trim()
  const index = Math.trunc(sense.index)
  if (!label || !Number.isFinite(index) || index < 1) return null
  const exact = coreSenseStatKey(index, label)
  if (stats[exact]) return exact
  let labelHit: string | null = null
  let indexHit: string | null = null
  for (const key of Object.keys(stats)) {
    const parsed = parseCoreSenseStatKey(key)
    if (!parsed) continue
    if (parsed.label === label && labelHit == null) labelHit = key
    if (parsed.index === index && indexHit == null) indexHit = key
  }
  return labelHit ?? indexHit
}

/** 某本义的不熟悉度（复用 familiarity；无统计/encounters=0 → null） */
export function coreSenseFamiliarity(
  stats: Record<string, MeaningStat> | null | undefined,
  sense: { index: number; label: string },
): number | null {
  const key = resolveCoreSenseStatKey(stats, sense)
  if (!key) return null
  const stat = stats![key]
  if (!stat) return null
  return familiarity(
    Number.isFinite(stat.clicks) ? Math.max(0, Math.floor(stat.clicks)) : 0,
    Number.isFinite(stat.encounters) ? Math.max(0, Math.floor(stat.encounters)) : 0,
  )
}

export interface CoreSenseInput {
  index: number
  label: string
}

export interface CoreSenseWeightedUnit {
  /** stats key（JSON 元组） */
  key: string
  /** pseudo SessionWord 中使用的 meaningId（`core:${key}`） */
  sessionMeaningId: string
  index: number
  label: string
  /** 该本义的不熟悉度（0–1；null=无统计） */
  familiarity: number | null
  /** 加权后的总次数（1–20） */
  totalRepeats: number
}

export interface BuildCoreSenseWeightedUnitsInput {
  /** 普通记忆 base（memory.totalRepeats，1–10） */
  base: number
  /** 当前有效 coreSenses（index 已重编号 1..N） */
  coreSenses: readonly CoreSenseInput[]
  coreSenseStats?: Record<string, MeaningStat> | null
  settings?: Partial<WeightedMemorySettings> | null
  /** 已标不常考的本义（Word.rareCoreSenses） */
  rareCoreSenses?: readonly RareCoreSense[] | null
  /** 默认 true：排除 rare 本义；false 时全部纳入（测试/未来设置用） */
  excludeRare?: boolean
}

export interface BuildCoreSenseWeightedUnitsResult {
  /** 参与加权记忆的本义单元（保持 coreSenses 顺序） */
  units: CoreSenseWeightedUnit[]
  /** pseudo meaningId → totalRepeats，直接传给 createSession({ weightedTotals }) */
  totals: Record<string, number>
  /** 因 rare 被排除的本义数 */
  excludedRare: number
  /** 是否有可用本义（false → UI 提示并回退普通加权） */
  hasUsable: boolean
}

function isRareCoreSense(
  sense: CoreSenseInput,
  rare: readonly RareCoreSense[] | null | undefined,
): boolean {
  if (!rare || rare.length === 0) return false
  const label = sense.label.trim()
  // label 优先（本义重排 index 变）；index 兜底
  if (rare.some((entry) => entry.label.trim() === label)) return true
  return rare.some((entry) => entry.coreSenseIndex === sense.index)
}

/**
 * 构建「只记本义」加权单元：
 * - 过滤非法 label/index；rare 默认排除；
 * - familiarity 独立于 meaningStats；每本义 total 用现有加权设置；
 * - 无可用本义返回 `units=[]`，由 UI 提示并回退普通加权（不创建空会话）。
 */
export function buildCoreSenseWeightedUnits(
  input: BuildCoreSenseWeightedUnitsInput,
): BuildCoreSenseWeightedUnitsResult {
  const excludeRare = input.excludeRare !== false
  const rare = input.rareCoreSenses ?? []
  const seen = new Set<string>()
  const units: CoreSenseWeightedUnit[] = []
  let excludedRare = 0

  for (const raw of input.coreSenses) {
    const index = Math.trunc(Number(raw.index))
    const label = String(raw.label ?? '').trim()
    if (!Number.isFinite(index) || index < 1 || !label) continue
    if (seen.has(label)) continue // 有效 coreSenses 已按 label 去重；脏数据兜底
    seen.add(label)
    if (excludeRare && isRareCoreSense({ index, label }, rare)) {
      excludedRare += 1
      continue
    }
    const key = coreSenseStatKey(index, label)
    const fam = coreSenseFamiliarity(input.coreSenseStats, { index, label })
    units.push({
      key,
      sessionMeaningId: `${CORE_SENSE_MEANING_PREFIX}${key}`,
      index,
      label,
      familiarity: fam,
      totalRepeats: weightedTotal(input.base, fam, input.settings),
    })
  }

  const totals: Record<string, number> = {}
  for (const unit of units) totals[unit.sessionMeaningId] = unit.totalRepeats
  return { units, totals, excludedRare, hasUsable: units.length > 0 }
}

/**
 * 构造「只记本义」会话用的 pseudo SessionWord：
 * - 单元 → meanings（meaningId=`core:${key}`，cn=label；pos 空）；
 * - 不修改入参 word，不污染真实 c；phrases 清空（本义无例句/词组位置）。
 */
export function toCoreSenseSessionWord(
  word: SessionWord,
  units: readonly CoreSenseWeightedUnit[],
): SessionWord {
  return {
    ...word,
    meanings: units.map((unit) => ({ meaningId: unit.sessionMeaningId, cn: unit.label })),
    phrases: [],
  }
}

/** 默认设置便捷导出（测试/UI 可显示当前加权设置） */
export { DEFAULT_WEIGHTED_MEMORY_SETTINGS }
