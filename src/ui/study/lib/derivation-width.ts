import type { SettingsMap } from '../../../core'

/** F9：右页分栏宽度（30%–75%，默认 46%，记忆在本机设置） */
export const DERIVATION_WIDTH_KEY = 'mm.derivationPanelWidth'
export const DERIVATION_WIDTH_MIN = 30
export const DERIVATION_WIDTH_MAX = 75
export const DERIVATION_WIDTH_DEFAULT = 50

export function clampDerivationPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return DERIVATION_WIDTH_DEFAULT
  return Math.min(DERIVATION_WIDTH_MAX, Math.max(DERIVATION_WIDTH_MIN, Math.round(value)))
}

/**
 * 拖动过程中的「跟手」宽度：允许 <30（松手才判定关闭），上限 75 夹紧；
 * 保留 1 位小数，保证 dx→% 1:1 连续。最终宽度仍用 `clampDerivationPanelWidth`（30–75）。
 */
export function clampLiveDerivationWidth(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(DERIVATION_WIDTH_MAX, Math.max(0, Math.round(value * 10) / 10))
}

/** 拖拽把手：按视口宽度把水平位移换算成百分比（向左拖变宽） */
export function derivationWidthFromDrag(input: {
  startWidth: number
  dx: number
  viewportWidth: number
}): number {
  const vw = input.viewportWidth > 0 ? input.viewportWidth : 1
  return clampDerivationPanelWidth(input.startWidth - (input.dx / vw) * 100)
}

/** task-187：右页滑动灵敏度（设置 derivation.swipeSensitivity；0.2–3.0，默认 1.0=1:1） */
export const SWIPE_SENSITIVITY_MIN = 0.2
export const SWIPE_SENSITIVITY_MAX = 3
export const SWIPE_SENSITIVITY_DEFAULT = 1

export function clampSwipeSensitivity(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return SWIPE_SENSITIVITY_DEFAULT
  return Math.min(SWIPE_SENSITIVITY_MAX, Math.max(SWIPE_SENSITIVITY_MIN, Math.round(value * 10) / 10))
}

/** 从 settings 读取灵敏度（键不在 SettingsMap 旧类型时安全回退 1.0） */
export function readSwipeSensitivity(settings: Partial<SettingsMap> | null | undefined): number {
  return clampSwipeSensitivity(settings?.['derivation.swipeSensitivity'])
}

export function readDerivationPanelWidth(storage?: Pick<Storage, 'getItem'> | null): number {
  try {
    const raw = storage?.getItem(DERIVATION_WIDTH_KEY)
    return raw == null ? DERIVATION_WIDTH_DEFAULT : clampDerivationPanelWidth(Number(raw))
  } catch {
    return DERIVATION_WIDTH_DEFAULT
  }
}
