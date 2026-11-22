import { useEffect, useRef, useState } from 'react'
import { FamiliarityBar, FamiliarityPercent } from './FamiliarityBar'
import { familiarityPercentLabel } from '../lib/familiarity-display'
import { formatPosLabel } from '../lib/pos-label'
import type { MeaningView } from './types'

export interface MeaningRowProps {
  meaning: MeaningView
  /** 点击整行 = 标记该含义不熟悉（clicks+1） */
  onMark: (meaningId: string) => void
  /** A10/C：该含义是否 nc */
  isNc?: boolean
  /** task-197：不常考含义 */
  isRare?: boolean
  onToggleRare?: (meaningId: string) => void
}

/**
 * 注释面含义行：词性（墨墨风 [名]/[动]）+ 中文 + clicks/encounters + 百分比 + 4px 不熟悉度条。
 * 整行可点（min-height 64px），点击有 120ms 高亮反馈（SPEC §4.6 / 03-ui §5.2.2）。
 * 长释义/更多义项（最多 12 个）时整行高度自适应、中文换行不溢出。
 */
export function MeaningRow({ meaning, onMark, isNc = false, isRare = false, onToggleRare }: MeaningRowProps) {
  const [flash, setFlash] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  const percent = familiarityPercentLabel(meaning.familiarity)
  const posLabel = formatPosLabel(meaning.pos)
  const handleMark = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10)
    }
    setFlash(true)
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setFlash(false), 120)
    onMark(meaning.meaningId)
  }

  return (
    <div className="meaning-row-wrap">
    <button
      type="button"
      className={`meaning-row${flash ? ' is-flash' : ''}`}
      onClick={handleMark}
      aria-label={`标记「${meaning.cn}」为不熟悉，当前不熟悉度 ${percent}`}
    >
      <span className="meaning-row-main">
        <span className="meaning-cn-wrap">
          {posLabel ? <span className="meaning-pos">{posLabel}</span> : null}
          {isNc ? <span className="mm-badge nc-badge">nc</span> : null}
          {isRare ? <span className="mm-badge rare-badge">不常考</span> : null}
          <span className="meaning-cn-text">{meaning.cn}</span>

        </span>
        <span className="meaning-meta">
          <span className="meaning-meta-ratio">
            {meaning.encounters > 0 ? `${meaning.clicks}/${meaning.encounters} ` : ''}
          </span>
          <span className="mm-caption">含义不熟</span>
          <FamiliarityPercent value={meaning.familiarity} />
        </span>
      </span>
      <FamiliarityBar value={meaning.familiarity} />
    </button>
    {onToggleRare ? (
      <button
        type="button"
        className={`rare-toggle-btn${isRare ? ' is-rare' : ''}`}
        aria-label={isRare ? `取消「${meaning.cn}」的不常考标记` : `标记「${meaning.cn}」为不常考`}
        aria-pressed={isRare}
        onClick={() => onToggleRare(meaning.meaningId)}
      >
        {isRare ? '取消不常考' : '标记不常考'}
      </button>
    ) : null}
    </div>
  )
}
