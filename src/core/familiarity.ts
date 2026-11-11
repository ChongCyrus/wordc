/**
 * 不熟悉度（SPEC §3.7 / §4.6 / AC2）。
 *
 * 定义：`familiarity(meaning) = clamp01(clicks / encounters)`
 *   - clicks     = 点过「标记不熟悉」的累计次数（可 > encounters，原始值保留）
 *   - encounters = 该含义被遇到的次数
 *   - 0/0 → null（UI 展示 `—`）
 *
 * 写入时机（D40 / SPEC §4.6，**由 UI 在指定时机调用 data 层，core 只做纯计算**）：
 *   - 进入注释面（每个词每次会话第一次 board→annotation）：该词**全部**含义 encounters += 1
 *   - 点击某含义行：该含义 clicks += 1
 */

import { clamp01 } from './params'
import type { MeaningStat } from './types'

/** 不熟悉度 f（0–1）；encounters=0 返回 null（UI 展示 `—`） */
export function familiarity(clicks: number, encounters: number): number | null {
  if (!Number.isFinite(encounters) || encounters <= 0) return null
  if (!Number.isFinite(clicks) || clicks <= 0) return 0
  return clamp01(clicks / encounters)
}

/** 空计数（缺省 key 时按 0/0 处理） */
export function emptyMeaningStat(): MeaningStat {
  return { clicks: 0, encounters: 0 }
}

/** 规范化一条计数：缺失/NaN/负数都收敛到合法值（读取时兜底，§1.3） */
export function normalizeMeaningStat(stat?: MeaningStat | null): MeaningStat {
  const clicks = Number.isFinite(stat?.clicks) ? Math.max(0, Math.floor(stat!.clicks)) : 0
  const encounters = Number.isFinite(stat?.encounters)
    ? Math.max(0, Math.floor(stat!.encounters))
    : 0
  return { clicks, encounters }
}

/** 点击一次「标记不熟悉」：返回新对象（不修改入参） */
export function applyMeaningClick(stat?: MeaningStat | null): MeaningStat {
  const s = normalizeMeaningStat(stat)
  return { clicks: s.clicks + 1, encounters: s.encounters }
}

/** 遇到一次（进入注释面）：返回新对象（不修改入参） */
export function applyMeaningEncounter(stat?: MeaningStat | null): MeaningStat {
  const s = normalizeMeaningStat(stat)
  return { clicks: s.clicks, encounters: s.encounters + 1 }
}

/** 批量 +encounters：给某词全部含义遇到一次（SPEC §4.6 进入注释面） */
export function applyMeaningEncounters(
  stats: Record<string, MeaningStat> | undefined,
  meaningIds: string[],
): Record<string, MeaningStat> {
  const next: Record<string, MeaningStat> = { ...(stats ?? {}) }
  for (const id of meaningIds) next[id] = applyMeaningEncounter(next[id])
  return next
}

/** 取某含义的不熟悉度（缺省 → null，展示 `—`） */
export function familiarityOfMeaning(
  stats: Record<string, MeaningStat> | undefined,
  meaningId: string,
): number | null {
  const stat = normalizeMeaningStat(stats?.[meaningId])
  return familiarity(stat.clicks, stat.encounters)
}
