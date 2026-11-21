/**
 * 加权记忆（F2，0.3.35）—— **纯函数**，不依赖 UI/存储。
 *
 * 背景：普通「记忆」对每个 w-c 使用固定 `memory.totalRepeats`（1–10）；
 * 「加权记忆」按该 c 的不熟悉度 f（0–1）把次数映射到 [min, max]，
 * 并以普通记忆次数 base 作为 **f=0.5 的中性锚点**（0.3.78 / task-233，方案 B 混合锚点）：
 *
 *   f ≤ 0.5:  total = clamp(round(base - (base - min) * k * (1 - 2f)), min, max)
 *   f >  0.5:  total = clamp(round(base + (max - base) * k * (2f - 1)), min, max)
 *
 * - f=0（最熟）→ 下界 min；f=0.5 → base（普通记忆次数）；f=1（最不熟）→ 上界 max；
 * - k=0 → 所有 f 都回到 clamp(base)（与旧「不放大」行为一致）；
 * - base 超出 [min,max] 时由最终 clamp 收敛；
 * - f=null/NaN 按 0 处理；普通记忆行为完全不变（本模块只被「加权记忆」入口使用）。
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
 * @example weightedTotal(3, 0) === 1    // f=0 最熟 → 下界
 * @example weightedTotal(3, 0.5) === 3   // 中性点 = 普通记忆 base
 * @example weightedTotal(3, 1) === 10    // f=1 最不熟 → 上界
 */
export function weightedTotal(
  base: number,
  familiarity: number | null | undefined,
  settings?: Partial<WeightedMemorySettings> | null,
): number {
  const cfg = normalizeWeightedMemorySettings(settings)
  const safeBase = clampInt(base, MEMORY_TOTAL_MIN, MEMORY_TOTAL_MAX, MEMORY_TOTAL_MIN)
  const f = normalizeFamiliarity(familiarity)
  // 方案 B：f=0→min、f=0.5→base、f=1→max；k 缩放两端偏离，k=0 回到 base
  const raw =
    f <= 0.5
      ? safeBase - (safeBase - cfg.minRepeats) * cfg.strength * (1 - 2 * f)
      : safeBase + (cfg.maxRepeats - safeBase) * cfg.strength * (2 * f - 1)
  return Math.min(cfg.maxRepeats, Math.max(cfg.minRepeats, Math.round(raw)))
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
