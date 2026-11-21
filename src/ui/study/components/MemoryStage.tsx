import { useEffect, useState } from 'react'
import { DerivationChain, type DerivationChainView } from './DerivationChain'
import { UserMnemonicLine, UserNoteLine } from './UserContent'
import type { UserMnemonicView, UserNoteView } from './types'
import type { PhraseView } from './types'
import type { MemorySummaryEntry, MemoryViewPhase } from '../../../core/session'

export interface MemoryStageProps {
  headword: string
  /** 当前含义中文 */
  meaningCn: string
  /** 当前含义词性（hidden 时可见，无则不显示） */
  meaningPos?: string
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
  /** F1：当前 c 例句（en+cn，最多 3） */
  examples?: Array<{ en: string; cn: string }>
  /** F1：当前 c 助记 */
  mnemonics?: Array<{ type: string; text: string }>
  /** task-217：只记本义会话显示当前本义助记/代表例句 */
  coreSenseMnemonic?: string | null
  coreSenseGloss?: string | null
  coreSenseOverview?: string | null
  /** task-226：core-only 页右上固定「只记本义/AI 本义内容」时，提示右侧预留安全区 */
  hasTopControls?: boolean
  coreSenseExamples?: Array<{ en: string; cn: string }>
  /** task-283：词根词缀词源（w-c 简洁显示，含义必显示） */
  rootEtymology?: {
    parts: Array<{ type: string; text: string; meaning: string }>
    etymology?: string
    composition?: string
  } | null
  /** F1：当前 c 不熟悉度 0–1 */
  familiarity?: number | null
  /** F1：不熟悉度排名 */
  unfamiliarityRank?: { rank: number; total: number } | null
  /** C：当前 w 生成元/核心义 */
  rootLabel?: string
  /** C：当前 c 对应的右页 lines 行（旧数据无则不渲染） */
  currentLine?: string
  /** C：当前 c 是否 nc */
  isNc?: boolean
  /** F6：当前 c 的用户笔记/助记（只读） */
  userNotes?: UserNoteView[]
  userMnemonics?: UserMnemonicView[]
  /** task-246：三小次开关开启时提示只显示单行短文案 */
  threeTapRecall?: boolean
  /** task-252：卡片刷新闪动（默认关闭，开启才按 count 重挂载 fade-in） */
  cardFlashAnimation?: boolean
  /** task-241：三拍渲染阶段与词级收尾 */
  memoryPhase?: MemoryViewPhase
  showMeaning?: boolean
  summaryEntries?: MemorySummaryEntry[]
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
  meaningPos,
  count,
  total,
  phraseLines,
  showPhrases,
  fontScale,
  cardSize,
  derivation,
  examples = [],
  mnemonics = [],
  coreSenseMnemonic = null,
  coreSenseGloss = null,
  coreSenseOverview = null,
  hasTopControls = false,
  coreSenseExamples = [],
  rootEtymology = null,
  familiarity,
  unfamiliarityRank,
  rootLabel,
  currentLine,
  isNc = false,
  userNotes = [],
  userMnemonics = [],
  threeTapRecall = false,
  cardFlashAnimation = false,
  memoryPhase = 'normal',
  showMeaning = true,
  summaryEntries = [],
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

  const showCardMeaning = showMeaning && memoryPhase !== 'final-summary'
  const visiblePhrases = showCardMeaning && showPhrases ? phraseLines.slice(0, 3) : []
  const cardKey = cardFlashAnimation ? `memory-card-${safeCount}` : 'memory-card'
  const showHint = !touched && !hintExpired && safeCount === 0

  const handleTap = () => {
    setTouched(true)
    onTap()
  }

  return (
    <div
      className={`memory-stage${isNc ? ' is-nc' : ''}${hasTopControls ? ' memory-stage--with-top-controls' : ''} memory-stage--${memoryPhase}`}
      role="button"
      tabIndex={0}
      aria-label={
        memoryPhase === 'final-summary'
          ? `记忆 ${headword} 全部映射，点击结束记忆`
          : showMeaning
            ? `记忆 ${headword} 对应 ${meaningCn}，已记 ${safeCount} / ${safeTotal} 次，轻点再加一次`
            : `记忆 ${headword}，点击继续（已记 ${safeCount} / ${safeTotal} 次）`
      }
      onClick={handleTap}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleTap()
        }
      }}
    >
      {showCardMeaning ? (
      <div
        className={`wc-memory-reminder${hasTopControls ? ' wc-memory-reminder--with-controls' : ''}`}
      >
        {threeTapRecall ? (
          <div className="wc-memory-reminder-lead">请熟悉/记忆下述映射</div>
        ) : (
          <details className="wc-root-process" open>
            <summary>推荐学习流程（点击展开/收起）</summary>
            <ol className="wc-root-process-list">
              <li>记忆词根缀含义。</li>
              <li>
                由词根缀词源（或相近词）含义拼成各具体含义/本义，然后进行接纳地记忆来巩固（以留印象为主，不要求在记忆类模块里直接记住，真正记忆主要依靠反复据白板回忆的反馈而针对性记忆/注意，直至白板下可以默写出所有含义/本义），只有跨度比较大时再巧记或直接进行接纳地记忆。
              </li>
            </ol>
          </details>
        )}
      </div>
      ) : null}
      {showCardMeaning && rootEtymology && rootEtymology.parts.length > 0 ? (
        <div className="wc-root-etymology">
          {rootEtymology.parts
            .map((part) => `${part.type === 'prefix' ? '前缀' : part.type === 'root' ? '词根' : part.type === 'suffix' ? '后缀' : '其他'} ${part.text}·${part.meaning}`)
            .join(' + ')}
          {rootEtymology.composition ? `　${rootEtymology.composition}` : ''}
        </div>
      ) : null}
      {showCardMeaning && (rootLabel || isNc) ? (
        <div className="wc-root-row">
          {rootLabel ? <span className="wc-root-label">生成元：{rootLabel}</span> : null}
          {isNc ? <span className="mm-badge nc-badge">nc</span> : null}
        </div>
      ) : null}
      <div
        className={`wc-card${cardFlashAnimation ? ' wc-card--flash' : ''}`}
        key={cardKey}
        style={
          {
            '--wc-card-size': String(safeCard),
            '--wc-word-size': `${wordSize}px`,
            '--wc-cn-size': `${cnSize}px`,
          } as React.CSSProperties
        }
      >
        <div className="wc-word">{headword}</div>
        {memoryPhase === 'hidden' || memoryPhase === 'final-hidden' ? (
          <>
            <div className="wc-arrow wc-hidden-arrow" aria-hidden="true">↓</div>
            <div className="wc-hidden-question-row">
              <span className="wc-hidden-question" aria-hidden="true">?</span>
              {(memoryPhase === 'hidden'
                ? (meaningPos ? [meaningPos] : [])
                : [
                    ...new Set(
                      summaryEntries
                        .filter((entry) => entry.kind === 'meaning' && entry.pos?.trim())
                        .map((entry) => entry.pos!.trim()),
                    ),
                  ]
              ).map((pos) => (
                <span className="wc-hidden-pos-item" key={`pos-${pos}`}>[{pos}]</span>
              ))}
            </div>
          </>
        ) : null}
        {showCardMeaning ? (
          <>
        <div className="wc-arrow" aria-hidden="true">
          ↓
        </div>
        <div className="wc-cn">{meaningCn}</div>
          </>
        ) : null}
        {showCardMeaning && coreSenseGloss ? (
          <div className="wc-core-sense-gloss">{coreSenseGloss}</div>
        ) : null}
        {showCardMeaning && coreSenseOverview ? (
          <div className="wc-core-sense-overview">
            <div className="wc-info-caption">本义串联记忆</div>
            <div>{coreSenseOverview}</div>
          </div>
        ) : null}
        {showCardMeaning && currentLine ? <div className="wc-cn-line">{currentLine}</div> : null}
        {showCardMeaning && derivation ? <DerivationChain {...derivation} compact /> : null}

      {showCardMeaning && (examples.length > 0 ||
        coreSenseExamples.length > 0 ||
        coreSenseMnemonic ||
        mnemonics.length > 0 ||
        userNotes.length > 0 ||
        userMnemonics.length > 0 ||
        currentLine ||
        familiarity != null ||
        unfamiliarityRank) ? (
        <div className="wc-info" onClick={(event) => event.stopPropagation()}>
          {familiarity != null ? (
            <div className="wc-familiarity">
              <div className="wc-familiarity-bar">
                <div
                  className="wc-familiarity-fill"
                  style={{ width: `${Math.round(Math.min(1, Math.max(0, familiarity)) * 100)}%` }}
                />
              </div>
              <span className="wc-info-caption">
                不熟悉度 {Math.round(familiarity * 100)}%
                {unfamiliarityRank ? ` · 第 ${unfamiliarityRank.rank} / ${unfamiliarityRank.total} 不熟悉` : ''}
              </span>
            </div>
          ) : null}
          {coreSenseMnemonic ? (
            <div className="wc-info-core-mnemonic">
              <span className="wc-info-caption">本义助记</span> {coreSenseMnemonic}
            </div>
          ) : null}
          {coreSenseExamples.map((example, index) => (
            <div className="wc-info-example" key={`core-ex-${example.en}-${index}`}>
              <span className="wc-info-caption">本义例句</span>
              <span className="wc-info-en">{example.en}</span>
              <span className="wc-info-cn">{example.cn}</span>
            </div>
          ))}
          {examples.map((example, index) => (
            <div className="wc-info-example" key={`${example.en}-${index}`}>
              <span className="wc-info-en">{example.en}</span>
              <span className="wc-info-cn">{example.cn}</span>
            </div>
          ))}
          {userNotes.map((note) => (
            <UserNoteLine key={note.id} note={note} />
          ))}
          {userMnemonics.map((mnemonic) => (
            <UserMnemonicLine key={mnemonic.id} mnemonic={mnemonic} />
          ))}
          {mnemonics.map((mnemonic, index) => (
            <div className="wc-info-mnemonic" key={`${mnemonic.type}-${index}`}>
              <span className="wc-info-caption">[{mnemonic.type}]</span> {mnemonic.text}
            </div>
          ))}
        </div>
      ) : null}
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

      {memoryPhase === 'final-summary' ? (
        <div className="wc-final-summary">
          <div className="wc-final-summary-title">本词全部映射</div>
          {summaryEntries.map((entry) => (
            <div className="wc-final-summary-row" key={entry.meaningId}>
              {entry.kind === 'core-sense' ? (
                <span>
                  本义「{entry.label ?? entry.cn}」
                  {entry.gloss ? <span className="wc-final-summary-gloss">：{entry.gloss}</span> : null}
                </span>
              ) : (
                <span>
                  {entry.pos ? `[${entry.pos}] ` : ''}
                  {entry.cn}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {showCardMeaning && visiblePhrases.length > 0 ? (
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
