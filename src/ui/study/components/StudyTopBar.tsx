import { ChevronLeftIcon, CloseIcon, MoreIcon } from './icons'

export interface StudyTopBarProps {
  /** 中间文案：普通阶段为 "3 / 50"；记忆页为 "2 / 5 个含义" */
  title: string
  /** 0–1 进度（顶部 2px 条） */
  progress: number
  onClose: () => void
  onMenu: () => void
  closeLabel?: string
  /** task-30：返回上一词（plan 驱动就绪后接入；首词/无 plan 时不传 = 隐藏） */
  onBack?: () => void
  backLabel?: string
}

/**
 * 学习页顶栏：左 ×（退出确认）/ 中进度 / 右 ⋮（菜单）。
 * 顶栏不参与「整屏点击」热区。
 */
export function StudyTopBar({
  title,
  progress,
  onClose,
  onMenu,
  closeLabel = '退出学习',
  onBack,
  backLabel = '上一个单词',
}: StudyTopBarProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)) * 100

  return (
    <>
      <div className="study-topbar">
        {onBack ? (
          <button type="button" className="study-icon-btn" aria-label={backLabel} onClick={onBack}>
            <ChevronLeftIcon size={22} />
          </button>
        ) : (
          <button type="button" className="study-icon-btn" aria-label={closeLabel} onClick={onClose}>
            <CloseIcon size={22} />
          </button>
        )}
        <span className="study-topbar-title" aria-live="polite">
          {title}
        </span>
        <div className="study-topbar-actions">
          <button type="button" className="study-icon-btn" aria-label="更多" onClick={onMenu}>
            <MoreIcon size={22} />
          </button>
          {onBack ? (
            <button type="button" className="study-icon-btn" aria-label={closeLabel} onClick={onClose}>
              <CloseIcon size={22} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="study-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="study-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </>
  )
}
