/** F9：右页分栏宽度（30%–75%，默认 46%，记忆在本机设置） */
export const DERIVATION_WIDTH_KEY = 'mm.derivationPanelWidth'
export const DERIVATION_WIDTH_MIN = 30
export const DERIVATION_WIDTH_MAX = 75
export const DERIVATION_WIDTH_DEFAULT = 46

export function clampDerivationPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return DERIVATION_WIDTH_DEFAULT
  return Math.min(DERIVATION_WIDTH_MAX, Math.max(DERIVATION_WIDTH_MIN, Math.round(value)))
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

export function readDerivationPanelWidth(storage?: Pick<Storage, 'getItem'> | null): number {
  try {
    const raw = storage?.getItem(DERIVATION_WIDTH_KEY)
    return raw == null ? DERIVATION_WIDTH_DEFAULT : clampDerivationPanelWidth(Number(raw))
  } catch {
    return DERIVATION_WIDTH_DEFAULT
  }
}
