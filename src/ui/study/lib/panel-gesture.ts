/**
 * 学习页「任意位置滑动 = 拖分界线」1:1 跟手手势（task-185，替代 task-184 的打开固定 50）。
 *
 * 规则（用户拍板）：
 * - 按下记 `startWidth`（面板未开 = 0）；
 * - 每帧 `rawWidth = startWidth - dx / viewportWidth * 100`，**不做打开帧跳 50、不重置锚点**；
 * - 未打开时左滑直接按 rawWidth 打开（约 10% 就是 10%），打开后继续拖连续变化、右滑连续收窄；
 * - 拖动中允许 <30 跟手（上限 75 夹紧）；**松手 <30 → 关闭**，否则最终 clamp 30–75；
 * - 死区 8–12px（取 10px）内不动；纵向手势不拦截、不 preventDefault；
 * - 触屏只走 touch（pointerType==='touch' 的 pointer 全部忽略），pointer 仅鼠标/笔兜底；
 * - pointercancel 不影响已开始的 touch 手势；touchcancel 不回滚已打开状态。
 *
 * 事件接线见 `use-study-panel-gesture.ts`（原生 touchmove passive:false）。
 */

import {
  DERIVATION_WIDTH_MAX,
  SWIPE_SENSITIVITY_DEFAULT,
  clampLiveDerivationWidth,
  clampSwipeSensitivity,
} from './derivation-width'

export interface PanelGestureEnv {
  isOpen: boolean
  widthPercent: number
  viewportWidth: number
  /** task-187：滑动灵敏度（0.2–3.0，默认 1.0=1:1） */
  sensitivity?: number
}

export type PanelGestureEffect =
  | { type: 'open'; widthPercent: number }
  | { type: 'close' }
  | { type: 'resize'; widthPercent: number }

export interface PanelGestureConfig {
  /** 方向死区（px，8–12；默认 10） */
  slop?: number
  /** 横向优先系数：|dx| >= |dy| * bias 视为横向 */
  horizontalBias?: number
}

export interface PanelGestureMoveResult {
  effects: PanelGestureEffect[]
  /** 外层是否应 preventDefault（横向手势、阻止滚动） */
  preventDefault: boolean
}

type Source = 'touch' | 'pointer'
type Axis = 'pending' | 'horizontal' | 'vertical'

interface GestureState {
  source: Source
  startX: number
  startY: number
  /** 按下时的宽度：面板未开 = 0 */
  startWidth: number
  axis: Axis
  opened: boolean
  lastX: number
  lastY: number
  lastWidth: number
}

const DEFAULTS: Required<PanelGestureConfig> = {
  slop: 10,
  horizontalBias: 1.2,
}

export class StudyPanelGestureController {
  private state: GestureState | null = null
  private readonly config: Required<PanelGestureConfig>

  constructor(
    private readonly getEnv: () => PanelGestureEnv,
    config?: PanelGestureConfig,
  ) {
    this.config = { ...DEFAULTS, ...(config ?? {}) }
  }

  get active(): boolean {
    return this.state != null
  }

  get axis(): Axis | null {
    return this.state?.axis ?? null
  }

  private env(): Required<PanelGestureEnv> {
    const env = this.getEnv()
    return {
      isOpen: env.isOpen === true,
      widthPercent: Math.min(DERIVATION_WIDTH_MAX, Math.max(0, env.widthPercent)),
      viewportWidth: env.viewportWidth > 0 ? env.viewportWidth : 1,
      sensitivity: clampSwipeSensitivity(env.sensitivity ?? SWIPE_SENSITIVITY_DEFAULT),
    }
  }

  private begin(source: Source, x: number, y: number): void {
    const env = this.env()
    this.state = {
      source,
      startX: x,
      startY: y,
      startWidth: env.isOpen ? env.widthPercent : 0,
      axis: 'pending',
      opened: false,
      lastX: x,
      lastY: y,
      lastWidth: env.isOpen ? env.widthPercent : 0,
    }
  }

  /**
   * 跟手宽度：raw = startWidth - (dx / vw * 100) × sensitivity。
   * sensitivity 默认 1.0 时就是分界线 1:1 拖拽；设置在 0.2–3.0。
   */
  private rawWidth(x: number, state: GestureState, env: Required<PanelGestureEnv>): number {
    return state.startWidth - ((x - state.startX) / env.viewportWidth) * 100 * env.sensitivity
  }

  private move(source: Source, x: number, y: number): PanelGestureMoveResult {
    const state = this.state
    const env = this.env()
    if (!state || state.source !== source) return { effects: [], preventDefault: false }
    state.lastX = x
    state.lastY = y
    const dx = x - state.startX
    const dy = y - state.startY
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)

    if (state.axis === 'pending') {
      if (Math.max(adx, ady) < this.config.slop) return { effects: [], preventDefault: false }
      if (adx >= ady * this.config.horizontalBias) state.axis = 'horizontal'
      else if (ady >= adx * this.config.horizontalBias) state.axis = 'vertical'
      else return { effects: [], preventDefault: false } // 方向未明：不抢滚动
    }
    if (state.axis === 'vertical') return { effects: [], preventDefault: false }

    const effects: PanelGestureEffect[] = []
    const raw = this.rawWidth(x, state, env)

    // 未打开：左滑立即按 rawWidth 打开（不设 24px 阈值、不当帧跳 50）
    if (!env.isOpen && !state.opened) {
      if (dx < 0 && raw > 0) {
        state.opened = true
        const width = clampLiveDerivationWidth(raw)
        state.lastWidth = width
        effects.push({ type: 'open', widthPercent: width })
        return { effects, preventDefault: true }
      }
      return { effects, preventDefault: true } // 横向但未产生正宽度：阻止滚动
    }

    // 已打开 / 本手势刚打开：1:1 连续调宽（允许 <30 跟手，下限 0；松手 <30 关闭）
    const width = clampLiveDerivationWidth(raw)
    if (width !== state.lastWidth) {
      state.lastWidth = width
      effects.push({ type: 'resize', widthPercent: width })
    }
    return { effects, preventDefault: true }
  }

  private finish(source: Source, x?: number): PanelGestureEffect[] {
    const state = this.state
    if (!state || state.source !== source) return []
    const env = this.env()
    const endX = x ?? state.lastX
    const effects: PanelGestureEffect[] = []
    const raw = this.rawWidth(endX, state, env)
    const wasOpen = env.isOpen || state.opened

    if (state.axis === 'horizontal' && wasOpen) {
      // task-190 修正：短滑/长滑一致——raw>0 松手保持当前宽度（10% 就是 10%，不吸附 30）；
      // 右滑只有 raw<=0 才关闭；上限 75 夹紧。
      if (raw <= 0) {
        effects.push({ type: 'close' })
      } else {
        const final = clampLiveDerivationWidth(raw)
        if (final !== state.lastWidth) effects.push({ type: 'resize', widthPercent: final })
      }
    }
    this.state = null
    return effects
  }

  private cancel(source: Source): PanelGestureEffect[] {
    const state = this.state
    if (!state || state.source !== source) return []
    this.state = null
    return []
  }

  // —— touch（触屏主路径；外层 touchmove passive:false）——
  touchStart(x: number, y: number): void {
    if (this.state) return
    this.begin('touch', x, y)
  }

  touchMove(x: number, y: number): PanelGestureMoveResult {
    return this.move('touch', x, y)
  }

  touchEnd(x?: number): PanelGestureEffect[] {
    return this.finish('touch', x)
  }

  touchCancel(): PanelGestureEffect[] {
    return this.cancel('touch')
  }

  // —— pointer（仅鼠标/笔；触屏 pointer 一律忽略，避免双路径）——
  pointerDown(x: number, y: number, pointerType: string, button = 0): void {
    if (pointerType === 'touch') return
    if (pointerType === 'mouse' && button !== 0) return
    if (this.state) return
    this.begin('pointer', x, y)
  }

  pointerMove(x: number, y: number, pointerType: string): PanelGestureMoveResult {
    if (pointerType === 'touch') return { effects: [], preventDefault: false }
    return this.move('pointer', x, y)
  }

  pointerUp(x?: number, pointerType = 'mouse'): PanelGestureEffect[] {
    if (pointerType === 'touch') return []
    return this.finish('pointer', x)
  }

  pointerCancel(pointerType = 'mouse'): PanelGestureEffect[] {
    if (pointerType === 'touch') return [] // 触屏 pointercancel 不影响 touch 手势
    return this.cancel('pointer')
  }

  reset(): void {
    this.state = null
  }
}

/** 未打开时左滑的「rawWidth 预设」（供 UI 提示/单测对照；含灵敏度） */
export function swipeOpenWidthFromDx(dx: number, viewportWidth: number, sensitivity = 1): number {
  const vw = viewportWidth > 0 ? viewportWidth : 1
  return clampLiveDerivationWidth((-dx / vw) * 100 * clampSwipeSensitivity(sensitivity))
}
