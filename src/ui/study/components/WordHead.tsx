import { SpeakerIcon } from './icons'

export type WordHeadSize = 'board' | 'annotation' | 'wc'

export interface WordHeadProps {
  headword: string
  /** 已按设置挑选好的音标文本；缺省/空串则整行隐藏（D33） */
  phonetic?: string
  size: WordHeadSize
  /** 是否显示发音按钮（默认 false；board/annotation 由设置决定） */
  showSpeak?: boolean
  speaking?: boolean
  onSpeak?: () => void
}

/**
 * 单词 + 音标 + 发音按钮。
 * - board：34–40px 青绿（大屏 40）
 * - annotation：30px 青绿
 * - wc：字号由 CSS 变量 --wc-word-size 控制（设置 memory.fontScale）
 */
export function WordHead({
  headword,
  phonetic,
  size,
  showSpeak = false,
  speaking = false,
  onSpeak,
}: WordHeadProps) {
  const visiblePhonetic = phonetic?.trim() ?? ''
  const showPhoneticRow = visiblePhonetic !== ''

  return (
    <div className={`word-head word-head--${size}`}>
      <div className="word-head-line">
        <span className="word-text">{headword}</span>
      </div>
      {showPhoneticRow ? (
        <div className="word-phonetic">
          <span className="word-phonetic-text">{visiblePhonetic}</span>
          {showSpeak && onSpeak ? (
            <button
              type="button"
              className={`speak-btn${speaking ? ' is-speaking' : ''}`}
              aria-label={`朗读 ${headword}`}
              onClick={(event) => {
                event.stopPropagation()
                onSpeak()
              }}
            >
              <SpeakerIcon size={20} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
