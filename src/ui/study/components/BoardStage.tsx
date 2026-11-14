import { useRef } from 'react'
import { WordHead } from './WordHead'
import { HighlightedText } from './HighlightedText'
import type { ExampleView } from './types'

export interface BoardMeaningHint {
  pos?: string
  examples?: Array<{ en: string; cn: string }>
  meaningId?: string
}

export interface BoardStageProps {
  headword: string
  phonetic?: string
  /**
   * 是否显示音标+发音（设置 board.showPhonetic）。
   * 音标数据缺失时整行隐藏（D33）。
   */
  showPhonetic: boolean
  /** 词级英文例句（不含中文）；按 board.exampleCount 截断 */
  examples: ExampleView[]
  /** F4：每个 c 的词性 + 英文例句（不显示中文） */
  meanings?: BoardMeaningHint[]
  /** F7：白板面显示各 c 英文词组（不显示中文） */
  showMeaningPhrases?: boolean
  phrases?: Array<{ en: string; meaningId?: string }>
  exampleCount: number
  speaking?: boolean
  onSpeak: () => void
  /** 整屏点击 → 进入注释面 */
  onNext: () => void
}

/**
 * 白板面：只显示单词 + 音标（可选）+ 英文例句（无中文）。
 * - 整屏可点（顶栏与发音按钮不在本组件内 / 已 stopPropagation）。
 * - 防误触锁由页面在进入注释面后对三键施加（研究 §5.1）。
 */
export function BoardStage({
  headword,
  phonetic,
  showPhonetic,
  examples,
  meanings = [],
  showMeaningPhrases = false,
  phrases = [],
  exampleCount,
  speaking = false,
  onSpeak,
  onNext,
}: BoardStageProps) {
  const firedRef = useRef(false)
  const visibleExamples = examples.slice(0, Math.max(0, Math.min(3, exampleCount)))

  const handleTap = () => {
    if (firedRef.current) return
    firedRef.current = true
    onNext()
  }

  return (
    <div
      className="board-stage"
      role="button"
      tabIndex={0}
      aria-label={`回忆 ${headword} 的释义，轻点进入注释面`}
      onClick={handleTap}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleTap()
        }
      }}
    >
      <div className="board-main">
        <WordHead
          headword={headword}
          phonetic={showPhonetic ? phonetic : undefined}
          size="board"
          showSpeak={showPhonetic}
          speaking={speaking}
          onSpeak={onSpeak}
        />
        {meanings.length > 0 ? (
          <div className="board-meanings">
            {meanings.map((meaning, index) => (
              <div className="board-meaning" key={index}>
                <span className="board-meaning-pos">{meaning.pos ?? ''}</span>
                {(meaning.examples ?? [])
                  .slice(0, Math.max(0, Math.min(3, exampleCount)))
                  .map((example) => (
                    <span className="board-meaning-en" key={example.en}>
                      {example.en}
                    </span>
                  ))}
                {showMeaningPhrases
                  ? phrases
                      .filter(
                        (phrase) =>
                          meaning.meaningId != null && phrase.meaningId === meaning.meaningId,
                      )
                      .slice(0, 3)
                      .map((phrase) => (
                        <span className="board-meaning-phrase" key={phrase.en}>
                          {phrase.en}
                        </span>
                      ))
                  : null}
              </div>
            ))}
          </div>
        ) : null}

        {visibleExamples.length > 0 ? (
          <div className="board-examples">
            {visibleExamples.map((example, index) => (
              <p className="board-example" key={`${example.en}-${index}`}>
                <HighlightedText text={example.en} word={headword} />
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <div className="stage-hint">轻点屏幕，回忆释义</div>
    </div>
  )
}
