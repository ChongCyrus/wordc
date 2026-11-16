/**
 * 加权记忆（F2，0.3.35）—— **纯函数**，不依赖 UI/存储。
 *
 * 背景：普通「记忆」对每个 w-c 使用固定 `memory.totalRepeats`（1–10）；
 * 「加权记忆」按该 c 的不熟悉度 f（0–1）放大次数，让不熟悉的 c 多练：
 *
 *   weightedTotal = clamp( round( base × (1 + k × f) ), min, max )
 *
 * - `base`：普通记忆总次数（`memory.totalRepeats`，1–10，越界读取时收敛）
 * - `f`：该 c 的不熟悉度（0–1；null/NaN 按 0 处理，即与普通记忆相同）
 * - `min`：加权最少次数（1–10，默认 1）
 * - `max`：加权最多次数（1–20，默认 10，且 ≥ min）
 * - `k`：加权强度（0–2，默认 1；k=0 时退化为「min/max 内的普通次数」）
 *
 * 普通记忆行为完全不变（该模块只被「加权记忆」入口使用）。
 */

/** 设置项范围（SPEC F2） */
export const WEIGHTED_MIN_MIN = 1
export const WEIGHTED_MIN_MAX = 10
export const WEIGHTED_MAX_MIN = 1
export const WEIGHTED_MAX_MAX = 20
export const WEIGHTED_K_MIN = 0
export const WEIGHTED_K_MAX = 2

/** 普通记忆总次数范围（与 memory.totalRepeats 一致） */
export const MEMORY_TOTAL_MIN = 1
export const MEMORY_TOTAL_MAX = 10

/** 加权记忆配置（设置页三项；均带默认值） */
export interface WeightedMemorySettings {
  /** 最少次数（1–10，默认 1） */
  minRepeats: number
  /** 最多次数（1–20，默认 10，≥ minRepeats） */
  maxRepeats: number
  /** 加权强度 k（0–2，默认 1） */
  strength: number
}

export const DEFAULT_WEIGHTED_MEMORY_SETTINGS: WeightedMemorySettings = {
  minRepeats: 1,
  maxRepeats: 10,
  strength: 1,
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 规范化配置：全部 clamp 到合法范围；max < min 时抬到 min（不抛错） */
export function normalizeWeightedMemorySettings(
  patch?: Partial<WeightedMemorySettings> | null,
): WeightedMemorySettings {
  const minRepeats = clampInt(
    patch?.minRepeats ?? DEFAULT_WEIGHTED_MEMORY_SETTINGS.minRepeats,
    WEIGHTED_MIN_MIN,
    WEIGHTED_MIN_MAX,
    DEFAULT_WEIGHTED_MEMORY_SETTINGS.minRepeats,
  )
  const maxRepeats = Math.max(
    minRepeats,
    clampInt(
      patch?.maxRepeats ?? DEFAULT_WEIGHTED_MEMORY_SETTINGS.maxRepeats,
      WEIGHTED_MAX_MIN,
      WEIGHTED_MAX_MAX,
      DEFAULT_WEIGHTED_MEMORY_SETTINGS.maxRepeats,
    ),
  )
  const strength = Math.min(
    WEIGHTED_K_MAX,
    Math.max(
      WEIGHTED_K_MIN,
      Number.isFinite(patch?.strength) ? (patch!.strength as number) : DEFAULT_WEIGHTED_MEMORY_SETTINGS.strength,
    ),
  )
  return { minRepeats, maxRepeats, strength }
}

/** 不熟悉度收敛：null/NaN/越界 → 0..1 */
function normalizeFamiliarity(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 单个 c 的加权总次数（核心公式，纯函数）。
 *
 * @example weightedTotal(3, 1, {minRepeats:1,maxRepeats:10,strength:1}) === 6
 * @example weightedTotal(3, 0) === 3   // 与普通记忆一致（受 min/max 约束）
 */
export function weightedTotal(
  base: number,
  familiarity: number | null | undefined,
  settings?: Partial<WeightedMemorySettings> | null,
): number {
  const cfg = normalizeWeightedMemorySettings(settings)
  const safeBase = clampInt(base, MEMORY_TOTAL_MIN, MEMORY_TOTAL_MAX, MEMORY_TOTAL_MIN)
  const f = normalizeFamiliarity(familiarity)
  const raw = Math.round(safeBase * (1 + cfg.strength * f))
  return Math.min(cfg.maxRepeats, Math.max(cfg.minRepeats, raw))
}

/** `weightedTotal` 的语义别名（UI 侧「选中加权记忆」时更直观） */
export function selectWeightedMemory(
  base: number,
  familiarity: number | null | undefined,
  settings?: Partial<WeightedMemorySettings> | null,
): number {
  return weightedTotal(base, familiarity, settings)
}

/**
 * 一批 c 的加权总次数（key = meaningId）。
 * UI 创建会话时把它传给 `createSession({ weightedTotals })`；缺失 key 回退普通 total。
 */
export function weightedMemoryTotals(
  base: number,
  familiarityByMeaning: Record<string, number | null | undefined>,
  settings?: Partial<WeightedMemorySettings> | null,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [meaningId, familiarity] of Object.entries(familiarityByMeaning)) {
    out[meaningId] = weightedTotal(base, familiarity, settings)
  }
  return out
}

/**
 * 从 SettingsMap 的三项设置构造配置（UI 直接传 `getSettings()` 结果即可）：
 * `memory.weightedMin / memory.weightedMax / memory.weightedK`
 */
export interface WeightedMemorySettingsSource {
  'memory.weightedMin': number
  'memory.weightedMax': number
  'memory.weightedK': number
}

export function weightedSettingsFromSettings(
  settings: Partial<WeightedMemorySettingsSource> | null | undefined,
): WeightedMemorySettings {
  return normalizeWeightedMemorySettings({
    minRepeats: settings?.['memory.weightedMin'] ?? DEFAULT_WEIGHTED_MEMORY_SETTINGS.minRepeats,
    maxRepeats: settings?.['memory.weightedMax'] ?? DEFAULT_WEIGHTED_MEMORY_SETTINGS.maxRepeats,
    strength: settings?.['memory.weightedK'] ?? DEFAULT_WEIGHTED_MEMORY_SETTINGS.strength,
  })
}

/** 加权次数是否与普通次数相同（k=0 或 f=0 且未触界时；UI 可提示「本次无加权」） */
export function isWeightedSameAsBase(
  base: number,
  familiarity: number | null | undefined,
  settings?: Partial<WeightedMemorySettings> | null,
): boolean {
  return weightedTotal(base, familiarity, settings) === clampInt(base, MEMORY_TOTAL_MIN, MEMORY_TOTAL_MAX, MEMORY_TOTAL_MIN)
}
