import { useState } from 'react'
import { WordHead } from './WordHead'
import { DerivationChain } from './DerivationChain'
import { AiBadge, MineBadge, UserMnemonicLine, UserNoteLine } from './UserContent'
import type { UserMnemonicView, UserNoteView } from './types'
import { MeaningRow } from './MeaningRow'
import { HighlightedText } from './HighlightedText'
import type { ExampleView, MeaningView, MnemonicView, PhraseView } from './types'
import { senseMnemonicLabel as mnemonicLabel } from './SenseMnemonicPanel'
import { FamiliarityBar, FamiliarityPercent } from './FamiliarityBar'

export interface AnnotationStageProps {
  headword: string
  phonetic?: string
  showPhonetic: boolean
  /** 该词全部本义（task-98/101；来自 getEffectiveContent().coreSenses，无则不渲染） */
  coreSenses?: Array<{ label: string; note?: string; origin?: string }>
  /** A10/C：nc 含义 id 列表 */
  ncMeaningIds?: string[]
  /** task-197：生成元映射（无数据不渲染；有 label 无 text 仍显示映射行） */
  rootLabel?: string
  rootParagraph?: string
  rootMnemonicText?: string
  onEditRootMnemonic?: () => void
  /** task-197：不常考含义 */
  rareMeaningIds?: string[]
  onToggleRareMeaning?: (meaningId: string) => void
  /** A：当前词 AI 标记不常考 */
  onAiMarkRare?: () => void
  /** 0.3.69：本义不常考标记 */
  rareCoreSenseIndexes?: number[]
  rareCoreSenseStale?: Array<{ coreSenseIndex: number; label: string; updatedAt: number }>
  hideRareBlocks?: boolean
  onCancelRareCoreSense?: (coreSenseIndex: number, label: string) => void
  onClearStaleRareCoreSenses?: () => void
  /** 0.3.71：手动标记/取消本义不常考（marked=true 立即标记；false 走二次确认） */
  onToggleRareCoreSense?: (coreSenseIndex: number, label: string, marked: boolean) => void
  /** 0.3.73：本义串联记忆（注释面顶部展示） */
  coreSenseOverview?: string | null
  /** 0.3.70：本义级不熟悉度（独立于 c） */
  coreSenseStatsByIndex?: Record<number, { clicks: number; encounters: number }>
  coreSenseFamiliarityByIndex?: Record<number, number | null>
  onCoreSenseClick?: (coreSenseIndex: number, label: string) => void
  /** task-200：本义助记（与生成元映射助记区分） */
  senseMnemonics?: Array<{ coreSenseIndex: number; label: string; text: string; source: 'manual' | 'ai' }>
  onOpenSenseMnemonicPanel?: () => void
  /** 点击本义助记块直接编辑该本义（深链） */
  onEditSenseMnemonic?: (coreSenseIndex: number) => void
  /** A9：点击单词弹出局部/接近词 */
  onHeadwordClick?: () => void
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
  ncMeaningIds = [],
  rootLabel,
  rootParagraph,
  rootMnemonicText,
  onEditRootMnemonic,
  rareMeaningIds = [],
  onToggleRareMeaning,
  onAiMarkRare,
  rareCoreSenseIndexes = [],
  rareCoreSenseStale = [],
  hideRareBlocks = false,
  onCancelRareCoreSense,
  onClearStaleRareCoreSenses,
  onToggleRareCoreSense,
  coreSenseOverview,
  coreSenseStatsByIndex,
  coreSenseFamiliarityByIndex,
  onCoreSenseClick,
  senseMnemonics = [],
  onOpenSenseMnemonicPanel,
  onEditSenseMnemonic,
  onHeadwordClick,
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
  const [expandedSenses, setExpandedSenses] = useState<Set<number>>(new Set())
  const [showHiddenRare, setShowHiddenRare] = useState(false)
  const seenOrigins = new Set<string>()
  const rareCoreSet = new Set(rareCoreSenseIndexes)
  const rareMeaningSet = new Set(rareMeaningIds)
  const hiddenMeaningCount = meanings.filter((meaning) => rareMeaningSet.has(meaning.meaningId)).length
  const hiddenCoreCount = coreSenses.filter((_, index) => rareCoreSet.has(index + 1)).length
  const hiddenCount = hiddenMeaningCount + hiddenCoreCount
  const forceShowRare = !hideRareBlocks || showHiddenRare
  const visibleMeanings = forceShowRare
    ? meanings
    : meanings.filter((meaning) => !rareMeaningSet.has(meaning.meaningId))
  const visibleCoreSenses = coreSenses
    .map((sense, index) => ({ sense, index }))
    .filter(({ index }) => forceShowRare || !rareCoreSet.has(index + 1))
  return (
    <div className="annotation-stage">
      <div className="annotation-head">
        {onHeadwordClick ? (
          <div
            className="annotation-headword-button"
            role="button"
            tabIndex={0}
            aria-label={`查看 ${headword} 的局部/接近词`}
            onClick={onHeadwordClick}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onHeadwordClick()
              }
            }}
          >
        <WordHead
          headword={headword}
          phonetic={showPhonetic ? phonetic : undefined}
          size="annotation"
          showSpeak={showPhonetic}
          speaking={speaking}
          onSpeak={onSpeak}
        />
          </div>
        ) : (
          <WordHead
            headword={headword}
            phonetic={showPhonetic ? phonetic : undefined}
            size="annotation"
            showSpeak={showPhonetic}
            speaking={speaking}
            onSpeak={onSpeak}
          />
        )}
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

      {(rootLabel || rootParagraph) ? (
        <div className="annotation-root-mapping">
          {rootLabel ? (
            <div className="annotation-root-line">
              <span className="annotation-root-word">{headword}</span>
              <span className="annotation-root-arrow" aria-hidden="true">↓</span>
              <span className="annotation-root-label">{rootLabel}</span>
            </div>
          ) : null}
          {rootParagraph ? <p className="annotation-root-text">{rootParagraph}</p> : null}
          {rootMnemonicText ? (
            <div className="annotation-root-mnemonic">映射助记：{rootMnemonicText}</div>
          ) : null}
          {onEditRootMnemonic ? (
            <button type="button" className="mm-btn mm-btn--sm" onClick={onEditRootMnemonic}>
              AI助记·生成元映射
            </button>
          ) : null}
        </div>
      ) : null}

      {onAiMarkRare || onOpenSenseMnemonicPanel ? (
        <div className="annotation-ai-rare">
          {onAiMarkRare ? (
            <button type="button" className="mm-btn mm-btn--sm" onClick={onAiMarkRare}>
              AI 标记不常考
            </button>
          ) : null}
          {onOpenSenseMnemonicPanel ? (
            <button type="button" className="mm-btn mm-btn--sm" onClick={onOpenSenseMnemonicPanel}>
              AI 本义助记
            </button>
          ) : null}
        </div>
      ) : null}

      {hideRareBlocks && hiddenCount > 0 ? (
        <button
          type="button"
          className="annotation-hidden-rare"
          onClick={() => setShowHiddenRare((prev) => !prev)}
        >
          {showHiddenRare
            ? `已临时显示 ${hiddenCount} 条不常考 · 点此恢复隐藏`
            : `已隐藏 ${hiddenCount} 条不常考 · 点此显示`}
        </button>
      ) : null}
      {rareCoreSenseStale.length > 0 ? (
        <div className="annotation-rare-stale">
          <span>本义已变化：{rareCoreSenseStale.length} 条旧本义不常考标记对不上当前本义</span>
          {onClearStaleRareCoreSenses ? (
            <button type="button" className="mm-btn mm-btn--sm" onClick={onClearStaleRareCoreSenses}>
              清理旧标记
            </button>
          ) : null}
        </div>
      ) : null}
      {visibleCoreSenses.length > 0 ? (
        <div className="core-senses">
          {coreSenseOverview?.trim() ? (
            <div className="core-sense-overview">
              <div className="core-sense-overview-title">本义串联记忆</div>
              <p className="core-sense-overview-text">{coreSenseOverview}</p>
            </div>
          ) : null}
          {visibleCoreSenses.map(({ sense, index }) => {
            const legacy = isLegacySenseLabel(sense.label)
            const mnemonic = senseMnemonics.find((entry) => entry.coreSenseIndex === index + 1)
            const origin = sense.origin?.trim()
            const showOrigin = Boolean(origin && !seenOrigins.has(origin))
            if (origin) seenOrigins.add(origin)
            const expanded = expandedSenses.has(index + 1)
            const longMnemonic = (mnemonic?.text.length ?? 0) > 36
            return (
              <section
                className={`core-sense-card${rareCoreSet.has(index + 1) ? ' is-rare' : ''}`}
                key={`${sense.label}-${index}`}
                onClick={(event) => {
                  if (rareCoreSet.has(index + 1)) return
                  const target = event.target as HTMLElement | null
                  if (target?.closest('button,a,input,textarea,select')) return
                  onCoreSenseClick?.(index + 1, sense.label)
                }}
              >
                <div className="core-sense-head">
                  <span className="core-sense-badge">本义{index + 1}</span>
                  <span className="core-sense-label">
                    {legacy ? '本义待重新生成' : sense.label}
                  </span>
                  {mnemonic ? (
                    <span className="core-sense-source">{mnemonic.source === 'manual' ? '我的' : 'AI'}</span>
                  ) : null}
                  {rareCoreSet.has(index + 1) && (!hideRareBlocks || showHiddenRare) ? (
                    <button
                      type="button"
                      className="core-sense-rare-badge"
                      aria-label={`取消本义${index + 1}「${sense.label}」的不常考标记`}
                      onClick={() => onCancelRareCoreSense?.(index + 1, sense.label)}
                    >
                      不常考
                    </button>
                  ) : null}
                </div>
                {legacy ? <div className="core-sense-note">原标签：{sense.label}</div> : null}
                {sense.note ? <div className="core-sense-gloss">{sense.note}</div> : null}
                {showOrigin ? <div className="core-sense-origin">词源：{origin}</div> : null}
                {mnemonic ? (
                  <div
                    className={`core-sense-mnemonic-block${longMnemonic && !expanded ? ' is-collapsed' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${mnemonicLabel(index + 1, sense.label)} 的助记，点击编辑`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (onEditSenseMnemonic) onEditSenseMnemonic(index + 1)
                      else onOpenSenseMnemonicPanel?.()
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        if (onEditSenseMnemonic) onEditSenseMnemonic(index + 1)
                        else onOpenSenseMnemonicPanel?.()
                      }
                    }}
                  >
                    <span className="core-sense-mnemonic-text">{mnemonic.text}</span>
                    {longMnemonic ? (
                      <span
                        className="core-sense-mnemonic-toggle"
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation()
                          setExpandedSenses((prev) => {
                            const next = new Set(prev)
                            if (next.has(index + 1)) next.delete(index + 1)
                            else next.add(index + 1)
                            return next
                          })
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            event.stopPropagation()
                            setExpandedSenses((prev) => {
                              const next = new Set(prev)
                              if (next.has(index + 1)) next.delete(index + 1)
                              else next.add(index + 1)
                              return next
                            })
                          }
                        }}
                      >
                        {expanded ? '收起' : '展开'}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="core-sense-stats">
                  <span className="core-sense-stat-ratio">
                    {coreSenseStatsByIndex?.[index + 1]?.clicks ?? 0}/
                    {coreSenseStatsByIndex?.[index + 1]?.encounters ?? 0}{' '}
                    <FamiliarityPercent value={coreSenseFamiliarityByIndex?.[index + 1] ?? null} />
                  </span>
                  <FamiliarityBar value={coreSenseFamiliarityByIndex?.[index + 1] ?? null} />
                </div>
                {onToggleRareCoreSense ? (
                  <button
                    type="button"
                    className={`rare-toggle-btn${rareCoreSet.has(index + 1) ? ' is-rare' : ''}`}
                    aria-label={
                      rareCoreSet.has(index + 1)
                        ? `取消本义${index + 1}「${sense.label}」的不常考标记`
                        : `标记本义${index + 1}「${sense.label}」为不常考`
                    }
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleRareCoreSense(index + 1, sense.label, !rareCoreSet.has(index + 1))
                    }}
                  >
                    {rareCoreSet.has(index + 1) ? '取消不常考' : '标记不常考'}
                  </button>
                ) : null}
              </section>
            )
          })}
        </div>
      ) : null}

      <div className="meanings">
        {visibleMeanings.length > 0 ? (
          visibleMeanings.map((meaning) => (
            <div key={meaning.meaningId}>
              <MeaningRow
                meaning={meaning}
                onMark={onMarkMeaning}
                isNc={ncMeaningIds.includes(meaning.meaningId)}
                isRare={rareMeaningIds.includes(meaning.meaningId)}
                {...(onToggleRareMeaning ? { onToggleRare: onToggleRareMeaning } : {})}
              />
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
                  <div
                    className={`meaning-mnemonic${onEditMnemonic ? ' is-editable' : ''}`}
                    key={`${meaning.meaningId}-${index}`}
                    {...(onEditMnemonic
                      ? {
                          role: 'button',
                          tabIndex: 0,
                          'aria-label': `编辑含义${meaning.cn} 的 AI 助记`,
                          onClick: () =>
                            onEditMnemonic({
                              meaningId: meaning.meaningId,
                              meaningCn: meaning.cn,
                              mnemonic,
                            }),
                          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              onEditMnemonic({
                                meaningId: meaning.meaningId,
                                meaningCn: meaning.cn,
                                mnemonic,
                              })
                            }
                          },
                        }
                      : {})}
                  >
                    <AiBadge />
                    <span className="meaning-mnemonic-type">[{mnemonic.type}]</span>
                    {mnemonic.text}
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
