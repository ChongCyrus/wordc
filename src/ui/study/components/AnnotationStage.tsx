import { WordHead } from './WordHead'
import { DerivationChain } from './DerivationChain'
import { MeaningRow } from './MeaningRow'
import { HighlightedText } from './HighlightedText'
import type { ExampleView, MeaningView, MnemonicView, PhraseView } from './types'

export interface AnnotationStageProps {
  headword: string
  phonetic?: string
  showPhonetic: boolean
  /** 该词全部本义（task-98/101；来自 getEffectiveContent().coreSenses，无则不渲染） */
  coreSenses?: Array<{ label: string; note?: string; origin?: string }>
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
/** 旧 v3 违规 label 判定（task-101）：>6 字或含说明性关键词 */
export function isLegacySenseLabel(label: string): boolean {
  const text = label.trim()
  if (text.length > 6) return true
  return /是否|看|检查|源自|英语|希腊|拉丁|词源|→/.test(text)
}

export function AnnotationStage({
  headword,
  phonetic,
  showPhonetic,
  coreSenses = [],
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

      {coreSenses.length > 0 ? (
        <div className="core-senses">
          {coreSenses.map((sense, index) => {
            const legacy = isLegacySenseLabel(sense.label)
            return (
              <div className="core-sense-line" key={`${sense.label}-${index}`}>
                <span className="core-sense-title">
                  本义{index + 1}「{legacy ? '本义待重新生成' : sense.label}」
                </span>
                {legacy ? (
                  <span className="core-sense-note"> 原标签：{sense.label}</span>
                ) : null}
                {sense.note ? <span className="core-sense-gloss">{sense.note}</span> : null}
                {sense.origin ? (
                  <span className="core-sense-origin">词源：{sense.origin}</span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="meanings">
        {meanings.length > 0 ? (
          meanings.map((meaning) => (
            <div key={meaning.meaningId}>
              <MeaningRow meaning={meaning} onMark={onMarkMeaning} />
              {meaning.derivation ? <DerivationChain {...meaning.derivation} /> : null}
              {meaning.examples?.map((example, exampleIndex) => (
                <div className="meaning-example" key={`${meaning.meaningId}-ex-${exampleIndex}`}>
                  <span className="meaning-example-en">{example.en}</span>
                  <span className="meaning-example-cn">{example.cn}</span>
                </div>
              ))}
              {mnemonics
                .filter((mnemonic) => mnemonic.meaningId === meaning.meaningId)
                .map((mnemonic, index) => (
                  <div className="meaning-mnemonic" key={`${meaning.meaningId}-${index}`}>
                    <span className="meaning-mnemonic-type">[{mnemonic.type}]</span>
                    {mnemonic.text}
                  </div>
                ))}
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

      {mnemonics.filter((mnemonic) => !mnemonic.meaningId).length > 0 ? (
        <>
          <div className="section-band">助记</div>
          <div className="section-body">
            {mnemonics
              .filter((mnemonic) => !mnemonic.meaningId)
              .map((mnemonic, index) => (
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
