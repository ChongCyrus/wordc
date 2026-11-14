import type { ReactNode } from 'react'
import type { Rating } from './types'

export interface ActionBarProps {
  /** 点「记忆」→ 开始/继续/重开一轮 w-c（按钮永远可点） */
  onMemory: () => void
  /** 加权记忆（F2）：与普通记忆流程一致，per-c total 用加权值；缺省不渲染 */
  onWeightedMemory?: () => void
  /** 提交评分 → 调度 + 持久化 → 下一词 */
  onRate: (rating: Rating) => void
  /**
   * 三个评分按钮下的「下次出现」副标题（由页面用 core 的预览函数计算）：
   * 认识「N 天后」/ 模糊「今日再出现 · N 天后」/ 不认识「今日再出现 · 明天」。
   * 缺省时不渲染副标题（布局与旧版一致）。
   */
  nextHints?: Partial<Record<Rating, string>>
  /** 三键主标签（官方按 is_first_show 切换；缺省用旧文案） */
  labels?: Partial<Record<Rating, string>>
  /** 回退浏览时高亮「上次选择」对应的三键（task-32 P3） */
  highlighted?: Rating | null
  /** 回退浏览时，三键上方的显式提示条（task-44，如 BackRevertNotice） */
  notice?: ReactNode
  /** 提交中/防误触锁定（400ms） */
  ratingDisabled?: boolean
}

const RATING_BUTTONS: Array<{ rating: Rating; label: string; className: string }> = [
  { rating: 'familiar', label: '认识', className: 'rating-btn--know' },
  { rating: 'vague', label: '模糊', className: 'rating-btn--vague' },
  { rating: 'forgot', label: '不认识', className: 'rating-btn--unknown' },
]

/**
 * 底部固定操作区：上方居中「记忆」+ 下方三键（认识/模糊/不认识，48px 均分）。
 * - 记忆按钮不做禁用（任务需求：任何时候都能开始/重开 w-c）。
 * - 三键下方可选显示「下次出现」小字（12px 次级色，不改变 48px 高度）。
 * 颜色用压深后的 token（D17），触控 ≥44px。
 */
export function ActionBar({
  onMemory,
  onWeightedMemory,
  onRate,
  nextHints,
  labels,
  highlighted,
  notice,
  ratingDisabled = false,
}: ActionBarProps) {
  return (
    <div className="action-bar" role="group" aria-label="学习操作">
      {notice ? <div className="action-bar-notice">{notice}</div> : null}
      <div className="memory-row">
        <button type="button" className="memory-btn" onClick={onMemory}>
          记忆
        </button>
        {onWeightedMemory ? (
          <button
            type="button"
            className="memory-btn memory-btn--weighted"
            onClick={onWeightedMemory}
          >
            加权记忆
          </button>
        ) : null}
      </div>
      <div className="rating-row">
        {RATING_BUTTONS.map((button) => {
          const hint = nextHints?.[button.rating]
          const label = labels?.[button.rating] ?? button.label
          return (
            <button
              key={button.rating}
              type="button"
              className={`rating-btn ${button.className}${
                highlighted === button.rating ? ' is-previous' : ''
              }`}
              onClick={() => onRate(button.rating)}
              disabled={ratingDisabled}
              aria-label={hint ? `${label}，${hint}` : label}
            >
              <span className="rating-label">{label}</span>
              {hint ? <span className="rating-sub">{hint}</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
