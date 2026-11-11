import { WordHead } from './WordHead'
import { DerivationChain } from './DerivationChain'
import { MeaningRow } from './MeaningRow'
import { HighlightedText } from './HighlightedText'
import type { ExampleView, MeaningView, MnemonicView, PhraseView } from './types'

export interface AnnotationStageProps {
  headword: string
  phonetic?: string
  showPhonetic: boolean
  meanings: MeaningView[]
  examples: ExampleView[]
  mnemonics: MnemonicView[]
  phrases: PhraseView[]
  /** 词组开关（D32：无数据时整块隐藏，设置仍保持有效） */
  showPhrases: boolean
  speaking?: boolean
  onSpeak: () => void
  /** 点含义行 = 标记「该含义不熟」 */
  onMarkMeaning: (meaningId: string) => void
}

/**
 * 注释面：单词/音标 + 含义行（可点标记不熟 + 不熟悉度条）+ 例句/助记/词组。
 * 底部操作区由页面渲染（固定定位），便于滚动时保持可见。
 */
export function AnnotationStage({
  headword,
  phonetic,
  showPhonetic,
  meanings,
  examples,
  mnemonics,
  phrases,
  showPhrases,
  speaking = false,
  onSpeak,
  onMarkMeaning,
}: AnnotationStageProps) {
  return (
    <div className="annotation-stage">
      <div className="annotation-head">
        <WordHead
          headword={headword}
          phonetic={showPhonetic ? phonetic : undefined}
          size="annotation"
          showSpeak={showPhonetic}
          speaking={speaking}
          onSpeak={onSpeak}
        />
      </div>

      <div className="meanings">
        {meanings.length > 0 ? (
          meanings.map((meaning) => (
            <div key={meaning.meaningId}>
              <MeaningRow meaning={meaning} onMark={onMarkMeaning} />
              {meaning.derivation ? <DerivationChain {...meaning.derivation} /> : null}
            </div>
          ))
        ) : (
          <p className="example-cn" style={{ padding: '16px 0' }}>
            暂无释义数据
          </p>
        )}
      </div>

      {examples.length > 0 ? (
        <>
          <div className="section-band">例句</div>
          <div className="section-body">
            {examples.map((example, index) => (
              <div className="example-item" key={`${example.en}-${index}`}>
                <p className="example-en">
                  <HighlightedText text={example.en} word={headword} />
                </p>
                {example.cn ? <p className="example-cn">{example.cn}</p> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {mnemonics.length > 0 ? (
        <>
          <div className="section-band">助记</div>
          <div className="section-body">
            {mnemonics.map((mnemonic, index) => (
              <p className="mnemonic-item" key={`${mnemonic.text}-${index}`}>
                <span className="mnemonic-type">{mnemonic.type}</span>
                {mnemonic.text}
              </p>
            ))}
          </div>
        </>
      ) : null}

      {showPhrases && phrases.length > 0 ? (
        <>
          <div className="section-band">词组</div>
          <div className="section-body">
            {phrases.map((phrase, index) => (
              <p className="phrase-row" key={`${phrase.en}-${index}`}>
                <span className="phrase-en">{phrase.en}</span>
                <span className="phrase-cn">— {phrase.cn}</span>
              </p>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
