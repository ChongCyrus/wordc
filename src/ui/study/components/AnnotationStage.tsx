import { WordHead } from './WordHead'
import { DerivationChain } from './DerivationChain'
import { AiBadge, MineBadge, UserMnemonicLine, UserNoteLine } from './UserContent'
import type { UserMnemonicView, UserNoteView } from './types'
import { MeaningRow } from './MeaningRow'
import { HighlightedText } from './HighlightedText'
import type { ExampleView, MeaningView, MnemonicView, PhraseView } from './types'

export interface AnnotationStageProps {
  headword: string
  phonetic?: string
  showPhonetic: boolean
  /** 该词全部本义（task-98/101；来自 getEffectiveContent().coreSenses，无则不渲染） */
  coreSenses?: Array<{ label: string; note?: string; origin?: string }>
  /** F6：用户笔记/助记（word 级 + c 级） */
  userNotes?: UserNoteView[]
  userMnemonics?: UserMnemonicView[]
  /** F6：打开用户笔记编辑（meaningId 缺省=词级） */
  onEditUserNote?: (target: { meaningId?: string; meaningCn?: string }) => void
  /** F6：新增/编辑用户助记（meaningId 缺省=词级） */
  onEditUserMnemonic?: (target: { meaningId?: string; meaningCn?: string }) => void
  /** F6 补充：编辑/删除 AI 或内置助记（保存为用户副本并隐藏原条目） */
  onEditMnemonic?: (target: {
    meaningId?: string
    meaningCn?: string
    mnemonic: { type: string; text: string }
  }) => void
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
  userNotes = [],
  userMnemonics = [],
  onEditUserNote,
  onEditUserMnemonic,
  onEditMnemonic,
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

      {onEditUserNote || onEditUserMnemonic ? (
        <div className="user-content-section">
          <div className="user-content-head">
            <span className="mm-caption">我的笔记/助记（词级）</span>
            <span style={{ display: 'flex', gap: 6 }}>
              {onEditUserNote ? (
                <button
                  type="button"
                  className="mm-btn mm-btn--ghost mm-btn--sm"
                  onClick={() => onEditUserNote({})}
                >
                  笔记
                </button>
              ) : null}
              {onEditUserMnemonic ? (
                <button
                  type="button"
                  className="mm-btn mm-btn--ghost mm-btn--sm"
                  onClick={() => onEditUserMnemonic({})}
                >
                  助记
                </button>
              ) : null}
            </span>
          </div>
          {userNotes.filter((note) => !note.meaningId).map((note) => (
            <UserNoteLine key={note.id} note={note} />
          ))}
          {userMnemonics
            .filter((mnemonic) => !mnemonic.meaningId)
            .map((mnemonic) => (
              <UserMnemonicLine key={mnemonic.id} mnemonic={mnemonic} />
            ))}
        </div>
      ) : null}

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
                    <AiBadge />
                    <span className="meaning-mnemonic-type">[{mnemonic.type}]</span>
                    {mnemonic.text}
                    {onEditMnemonic ? (
                      <button
                        type="button"
                        className="mm-btn mm-btn--ghost mm-btn--sm"
                        onClick={() =>
                          onEditMnemonic({
                            meaningId: meaning.meaningId,
                            meaningCn: meaning.cn,
                            mnemonic,
                          })
                        }
                      >
                        编辑
                      </button>
                    ) : null}
                  </div>
                ))}
              {userNotes
                .filter((note) => note.meaningId === meaning.meaningId)
                .map((note) => (
                  <UserNoteLine key={note.id} note={note} />
                ))}
              {userMnemonics
                .filter((mnemonic) => mnemonic.meaningId === meaning.meaningId)
                .map((mnemonic) => (
                  <UserMnemonicLine key={mnemonic.id} mnemonic={mnemonic} />
                ))}
              {onEditUserNote || onEditUserMnemonic ? (
                <span className="meaning-user-actions">
                  {onEditUserNote ? (
                    <button
                      type="button"
                      className="mm-btn mm-btn--ghost mm-btn--sm"
                      aria-label={`编辑含义 ${meaning.cn} 的我的笔记`}
                      onClick={() => onEditUserNote({ meaningId: meaning.meaningId, meaningCn: meaning.cn })}
                    >
                      <MineBadge /> 笔记
                    </button>
                  ) : null}
                  {onEditUserMnemonic ? (
                    <button
                      type="button"
                      className="mm-btn mm-btn--ghost mm-btn--sm"
                      aria-label={`编辑含义 ${meaning.cn} 的我的助记`}
                      onClick={() => onEditUserMnemonic({ meaningId: meaning.meaningId, meaningCn: meaning.cn })}
                    >
                      <MineBadge /> 助记
                    </button>
                  ) : null}
                </span>
              ) : null}
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
