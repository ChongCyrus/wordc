/**
 * 「每日学习量」变更（task-35）：写设置 + 要求 data 重算今日计划，并把结果转成产品文案。
 *
 * data 层 task-34：`updateDailyGoalAndResync(newGoal, {now, deckId?})` → 单事务写 settings + 重算 plan，
 * 返回 `{settings, plan, added, removed, total, newBudget, reviewCount, newCount}`（plan=null 表示今日无计划）。
 */
import { updateDailyGoalAndResync } from '../../data'

/** data 重算结果中 UI 需要的部分 */
export interface GoalResyncResult {
  /** 追加的新学词数 */
  added: number
  /** 移除的尾部未学新词数 */
  removed: number
  /** 重算后的队列总数（含回炉重复） */
  total: number
  /** 重算后的新学词数 */
  newCount?: number
  /** 本 plan 的复习词数 */
  reviewCount?: number
}

export type DailyGoalResync = (goal: number) => Promise<GoalResyncResult | null>

export interface DailyGoalChangeOutcome {
  /** 设置是否已写入 */
  ok: boolean
  /** 是否重算了今日计划 */
  resynced: boolean
  added: number
  removed: number
  total: number | null
  /** 给用户看的 toast 文案 */
  message: string
}

/** 按「增加/减少的净词数」生成产品要求的 toast 文案 */
export function buildGoalResyncMessage(result: GoalResyncResult | null): string {
  if (!result) return '每日学习量已更新（今日暂无计划需要调整）'
  const net = result.added - result.removed
  const base =
    net > 0
      ? `已按新学习量调整今日计划：+${net} 词`
      : net < 0
        ? `已按新学习量调整今日计划：-${Math.abs(net)} 词`
        : `已按新学习量调整今日计划：今日共 ${result.total} 词`
  // 边界：新目标 ≤ 今日复习数 → 新学预算为 0，明确提示
  if (result.newCount === 0 && (result.reviewCount ?? 0) > 0) {
    return `${base}（复习已占满目标，今日新学为 0）`
  }
  return base
}

/** 默认 data 实现：没有今天 plan 时返回 null（只写设置） */
const defaultResync: DailyGoalResync = async (goal) => {
  const result = await updateDailyGoalAndResync(goal)
  if (!result.plan) return null
  return {
    added: result.added,
    removed: result.removed,
    total: result.total,
    newCount: result.newCount,
    reviewCount: result.reviewCount,
  }
}

/**
 * 应用新的每日学习量（设置页 / 学习页快捷设置共用）。
 * - 有今日可续 plan → data 重算并返回 +N/-N 文案；
 * - 今日无 plan → 只写设置；
 * - 失败不阻塞：返回 ok:false + 中文错误，由调用方 toast。
 */
export async function applyDailyGoalChange(
  goal: number,
  resync: DailyGoalResync = defaultResync,
): Promise<DailyGoalChangeOutcome> {
  if (!Number.isInteger(goal) || goal < 1 || goal > 9999) {
    return {
      ok: false,
      resynced: false,
      added: 0,
      removed: 0,
      total: null,
      message: '每日学习量需为 1–9999 的整数',
    }
  }
  try {
    const result = await resync(goal)
    if (!result) {
      return {
        ok: true,
        resynced: false,
        added: 0,
        removed: 0,
        total: null,
        message: '每日学习量已更新（今日暂无计划需要调整）',
      }
    }
    return {
      ok: true,
      resynced: true,
      added: result.added,
      removed: result.removed,
      total: result.total,
      message: buildGoalResyncMessage(result),
    }
  } catch (error) {
    return {
      ok: false,
      resynced: false,
      added: 0,
      removed: 0,
      total: null,
      message: `每日学习量保存失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}
