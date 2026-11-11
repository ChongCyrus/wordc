import { useEffect, useState } from 'react'
import { DerivationChain, type DerivationChainView } from './DerivationChain'
import type { PhraseView } from './types'

export interface MemoryStageProps {
  headword: string
  /** 当前含义中文 */
  meaningCn: string
  /** 当前含义已记忆次数 */
  count: number
  /** 总次数（设置 memory.totalRepeats，1–10） */
  total: number
  /** 含 w/c 的词组（最多 3 条）；无数据时整块不渲染（D32） */
  phraseLines: PhraseView[]
  showPhrases: boolean
  /** w-c 字号倍数（0.8–1.6） */
  fontScale: number
  /** 卡片大小倍数（0.8–1.4） */
  cardSize: number
  /** 当前 c 的本义→引申链（task-77；无映射不渲染） */
  derivation?: DerivationChainView
  /** 整屏点击 = 记忆一次 */
  onTap: () => void
}

/** 超长文本降字号（SPEC §4.5：min(fontSize, clamp(24px, 8vw, 34px))） */
function fitFontSize(base: number, text: string, maxLen: number, minPx: number): number {
  if (text.length <= maxLen) return Math.round(base)
  return Math.round(Math.min(base, Math.max(minPx, Math.min(34, base * 0.78))))
}

/**
 * 记忆 w-c 页：全屏居中大卡片「英文 w → 中文 c」。
 * - 整屏（顶栏以外）点击 +1；满次数由页面调 core.advanceMemory 切换下一个 c。
 * - 次数「当前 / 总次数」+ 点阵；词组块由设置开关控制，无数据不占位。
 */
export function MemoryStage({
  headword,
  meaningCn,
  count,
  total,
  phraseLines,
  showPhrases,
  fontScale,
  cardSize,
  derivation,
  onTap,
}: MemoryStageProps) {
  const [touched, setTouched] = useState(false)
  const [hintExpired, setHintExpired] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setHintExpired(true), 4000)
    return () => window.clearTimeout(timer)
  }, [])

  const safeTotal = Math.max(1, Math.min(10, Math.round(total)))
  const safeCount = Math.max(0, Math.min(safeTotal, Math.round(count)))
  const safeScale = Math.max(0.8, Math.min(1.6, fontScale))
  const safeCard = Math.max(0.8, Math.min(1.4, cardSize))

  const wordSize = fitFontSize(36 * safeScale, headword, 12, 24)
  const cnSize = fitFontSize(34 * safeScale, meaningCn, 16, 24)

  const visiblePhrases = showPhrases ? phraseLines.slice(0, 3) : []
  const showHint = !touched && !hintExpired && safeCount === 0

  const handleTap = () => {
    setTouched(true)
    onTap()
  }

  return (
    <div
      className="memory-stage"
      role="button"
      tabIndex={0}
      aria-label={`记忆 ${headword} 对应 ${meaningCn}，已记 ${safeCount} / ${safeTotal} 次，轻点再加一次`}
      onClick={handleTap}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleTap()
        }
      }}
    >
      <div
        className="wc-card"
        style={
          {
            '--wc-card-size': String(safeCard),
            '--wc-word-size': `${wordSize}px`,
            '--wc-cn-size': `${cnSize}px`,
          } as React.CSSProperties
        }
      >
        <div className="wc-word">{headword}</div>
        <div className="wc-arrow" aria-hidden="true">
          ↓
        </div>
        <div className="wc-cn">{meaningCn}</div>
        {derivation ? <DerivationChain {...derivation} compact /> : null}
        <div className="wc-count-row">
          <span className={`wc-count${safeCount > 0 ? ' is-bump' : ''}`} key={safeCount}>
            {safeCount} / {safeTotal}
          </span>
        </div>
        <div className="wc-dots" aria-hidden="true">
          {Array.from({ length: safeTotal }, (_, index) => (
            <span
              key={index}
              className={`wc-dot${index < safeCount ? ' is-filled' : ''}`}
            />
          ))}
        </div>
      </div>

      {visiblePhrases.length > 0 ? (
        <div className="wc-phrases">
          {visiblePhrases.map((phrase, index) => (
            <span className="wc-phrase-line" key={`${phrase.en}-${index}`}>
              {phrase.en} — {phrase.cn}
            </span>
          ))}
        </div>
      ) : null}

      {showHint ? <div className="memory-hint">轻点屏幕，记忆一次</div> : null}
    </div>
  )
}
