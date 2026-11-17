import { OwlIcon } from './icons'

export type CompletionVariant = 'done' | 'empty' | 'no-deck'

export interface CompletionPageProps {
  variant: CompletionVariant
  /** 本次会话实际评分过的词数 */
  learnedCount?: number
  /** 用时（分钟，向上取整，最少 1） */
  minutes?: number
  onPrimary: () => void
  onSecondary: () => void
}

const CONTENT: Record<
  CompletionVariant,
  { title: string; primary: string; secondary: string }
> = {
  done: { title: '今日任务完成！', primary: '查看统计', secondary: '回首页' },
  empty: { title: '今日没有待学习的单词', primary: '去词库加学', secondary: '回首页' },
  'no-deck': { title: '还没有词库', primary: '去添加词库', secondary: '回首页' },
}

/**
 * 学习完成页 / 空状态页（队列空、无词库）。
 * 猫头鹰单色 SVG 只出现在此处（03-ui §2.4 / §4.9）。
 */
export function CompletionPage({
  variant,
  learnedCount = 0,
  minutes = 1,
  onPrimary,
  onSecondary,
}: CompletionPageProps) {
  const content = CONTENT[variant]
  const subtitle =
    variant === 'done'
      ? `学习 ${learnedCount} 个 · 用时 ${Math.max(1, Math.round(minutes))} 分钟`
      : variant === 'empty'
        ? '明天再来，或去词库手动加学新词。'
        : '还没有可学习的词库，先去词库页添加或导入一个吧。'

  return (
    <div className="completion">
      <OwlIcon size={96} className="completion-owl" />
      <h1 className="completion-title">{content.title}</h1>
      <p className="completion-sub">{subtitle}</p>
      <div className="completion-actions">
        <button type="button" className="study-btn study-btn--primary" onClick={onPrimary}>
          {content.primary}
        </button>
        <button type="button" className="study-btn" onClick={onSecondary}>
          {content.secondary}
        </button>
      </div>
    </div>
  )
}
