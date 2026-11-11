/**
 * 单词卡水平右滑回退（task-30 框架）。
 * 规则（SPEC-v2 §7.3）：水平滑动 ≥32px 且以水平为主 → 回退；与整屏点击翻面区分。
 * 这里用 64px 阈值（task-30 要求 ≥64px）并做方向锁定，纯函数便于单测。
 */

export interface SwipePoint {
  x: number
  y: number
}

/** 触发回退的水平距离阈值（px） */
export const SWIPE_BACK_THRESHOLD = 64

/**
 * 是否应触发「上一个词」：
 * - 向右滑（dx > 0）且 dx ≥ threshold；
 * - 且以水平方向为主（|dx| > |dy| * 1.2），避免和纵向滚动冲突。
 */
export function shouldTriggerSwipeBack(
  start: SwipePoint,
  end: SwipePoint,
  threshold = SWIPE_BACK_THRESHOLD,
): boolean {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  if (dx < threshold) return false
  return Math.abs(dx) > Math.abs(dy) * 1.2
}

/**
 * 拖动过程中的卡片位移（带阻尼，最多 max px）；
 * 仅向右、仅在水平方向明显时产生位移，纵向滚动时返回 0（不干扰滚动）。
 */
export function swipeDragOffset(start: SwipePoint, end: SwipePoint, max = 96): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0
  if (dx <= 0) return 0
  if (Math.abs(dx) <= Math.abs(dy)) return 0
  return Math.min(max, dx * 0.6)
}
