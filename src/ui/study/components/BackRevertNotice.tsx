import type { Rating } from './types'

/** 官方「之后」文案（认识/模糊/忘记） */
const LAST_CHOICE_LABEL: Record<Rating, string> = {
  familiar: '认识',
  vague: '模糊',
  forgot: '忘记',
}

export interface BackRevertNoticeProps {
  /** 该词今天最近一次未撤销的评分；null/undefined 时只显示「正在回看上一词」 */
  rating: Rating | null | undefined
  /** 不改判，回到当前进度 */
  onContinue: () => void
}

/**
 * 回退浏览上一词时的显式提示条（task-44，QA P3「改判入口可发现性」）。
 * - 位于三键上方（由 ActionBar.notice 插入）；
 * - 浅青底 + 左侧强调竖线，字号 13px，360px 宽最多两行；
 * - 三键仍可用：点任一评分键 = 改判（reRateInPlan），或点「不改了，继续」返回。
 */
export function BackRevertNotice({ rating, onContinue }: BackRevertNoticeProps) {
  const label = rating ? LAST_CHOICE_LABEL[rating] : null
  return (
    <div className="back-revert-notice" role="status" aria-live="polite">
      <div className="back-revert-notice-text">
        <span className="back-revert-line">
          正在回看上一词{label ? ` · 上次选择「${label}」` : ''}
        </span>
        <span className="back-revert-line">
          点下方评分键即可改判，或
          <button type="button" className="back-revert-continue" onClick={onContinue}>
            不改了，继续
          </button>
        </span>
      </div>
    </div>
  )
}
