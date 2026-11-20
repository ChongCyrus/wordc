import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { subTapAfterTap } from '../../../core'
import { MermaidPreview } from './DerivationPanel'
import { MarkdownText } from './DerivationMarkdown'

export interface GenerativeMeaningView {
  meaningId: string
  pos?: string
  cn: string
  examples?: Array<{ en: string; cn: string }>
}

export type GenerativePhase = 1 | 2 | 3 | 4

export interface GenerativeMemoryStageProps {
  open: boolean
  word: string
  rootLabel?: string
  text?: string
  mermaid?: string
  showMermaid: boolean
  rootFontScale: number
  clicksRequired: number
  /** task-242：三拍回忆（默认 true） */
  threeTapRecall?: boolean
  /** task-252：卡片刷新闪动（默认关闭） */
  cardFlashAnimation?: boolean
  perScreen: number
  meanings: GenerativeMeaningView[]
  initialNc: string[]
  aiBusy?: boolean
  aiError?: string | null
  onAiGenerate?: () => void
  onSaveMap?: () => void
  /** 浮层内可见的保存反馈（task-182） */
  saveStatus?: string | null
  /** task-197：打开「AI助记·生成元映射」编辑/生成 */
  onEditRootMnemonic?: () => void
  /** task-197：已保存的 w→生成元 映射助记（阶段2 只读展示，与注释面共享） */
  rootMnemonicText?: string
  onSaveNc: (ids: string[]) => void
  onClose: () => void
  /** 测试/调试：直接进入某阶段（默认 1） */
  initialPhase?: GenerativePhase
}

/** task-197：取引申图文字第一段（优先「本义/核心义：」开头的段/行） */
export function extractRootParagraph(text: string | undefined): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const cleaned = lines.map((line) => line.trim()).filter(Boolean)
  const core =
    cleaned.find((line) => /^(?:[-*]\s*)?(本义|核心义)/.test(line)) ||
    cleaned.find((line) => /(本义|核心义)[：:]/.test(line))
  if (core) return core.replace(/^[-*]\s*/, '').replace(/^>\s*/, '')
  return cleaned[0]?.replace(/^[-*]\s*/, '') ?? ''
}

/** B：生成式记忆四阶段（1 映射 → 2 w↓生成元点击计数 → 3 代入例句找 nc → 4 关系网络） */
export function GenerativeMemoryStage({
  open,
  word,
  rootLabel,
  text,
  mermaid,
  showMermaid,
  rootFontScale,
  clicksRequired,
  threeTapRecall = true,
  cardFlashAnimation = false,
  perScreen,
  meanings,
  initialNc,
  aiBusy = false,
  aiError = null,
  onAiGenerate,
  onSaveMap,
  saveStatus,
  onEditRootMnemonic,
  rootMnemonicText,
  onSaveNc,
  onClose,
  initialPhase = 1,
}: GenerativeMemoryStageProps) {
  const [phase, setPhase] = useState<GenerativePhase>(initialPhase)
  const [count, setCount] = useState(0)
  const [selected, setSelected] = useState<string[]>(initialNc)
  const [page, setPage] = useState(0)
  const [subTap, setSubTap] = useState<'full' | 'hidden' | 'verify'>('full')
  const rootParagraph = extractRootParagraph(text)

  useEffect(() => {
    if (!open) return
    setPhase(initialPhase)
    setCount(0)
    setSelected(initialNc)
    setPage(0)
    setSubTap('full')
    // 只在打开/换词时重置；nc 保存回调会让 initialNc 变化，绝不能重置阶段
  }, [open, word, initialPhase])

  const ncMeanings = useMemo(
    () => meanings.filter((meaning) => selected.includes(meaning.meaningId)),
    [meanings, selected],
  )
  const totalPages = Math.max(1, Math.ceil(meanings.length / Math.max(1, perScreen)))
  const pageItems = meanings.slice(page * perScreen, page * perScreen + perScreen)

  if (!open) return null

  const tapCount = () => {
    if (phase !== 2) return
    if (!threeTapRecall) {
      const next = count + 1
      setCount(next)
      if (next >= clicksRequired) setPhase(3)
      return
    }
    const nextTap = subTapAfterTap(subTap)
    if (nextTap.countIncrement) {
      const next = count + 1
      setCount(next)
      setSubTap('full')
      if (next >= clicksRequired) setPhase(3)
    } else {
      setSubTap(nextTap.subTap)
    }
  }
  const phase2ShowMeaning = !threeTapRecall || subTap !== 'hidden'

  /** task-197：阶段2 整屏非交互区域均可计数 */
  const handlePhase2Click = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('button,a,input,textarea,select,[role="button"]')) return
    tapCount()
  }

  return (
    <div className="generative-stage" role="dialog" aria-label="生成式记忆">
      <div className="generative-head">
        <span className="mm-row-title">生成式记忆 · 阶段 {phase}/4</span>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onClose}>
          退出
        </button>
      </div>

      {phase === 1 ? (
        <div className="generative-scroll">
          <p className="mm-caption">请记忆单词到生成元的映射，并理解它如何引申出各实际含义</p>
          <div className="generative-root" style={{ fontSize: `${Math.round(22 * rootFontScale)}px` }}>
            {word} → {rootLabel ?? '（未生成，请点 AI 生成）'}
          </div>
          <div className="generative-text">
            {text?.trim() ? <MarkdownText text={text} /> : <div className="mm-caption">请点击 AI 生成</div>}
          </div>
          {showMermaid ? <MermaidPreview source={mermaid ?? ''} /> : null}
          <div className="mm-btn-row generative-actions">
            {onAiGenerate ? (
              <button type="button" className="mm-btn" onClick={onAiGenerate} disabled={aiBusy}>
                {aiBusy ? '生成中…' : 'AI 生成'}
              </button>
            ) : null}
            {onSaveMap ? (
              <button type="button" className="mm-btn mm-btn--primary" onClick={onSaveMap}>
                保存
              </button>
            ) : null}
          </div>
          {aiError ? <div className="mm-caption mm-danger-text">{aiError}</div> : null}
          {saveStatus ? (
            <div className="generative-feedback" role="status">
              {saveStatus}
            </div>
          ) : null}
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setPhase(2)}>
            下一步
          </button>
        </div>
      ) : null}

      {phase === 2 ? (
        <div className="generative-scroll generative-phase2" onClick={handlePhase2Click}>
          <div className="generative-phase2-body">
            <div
              className={`wc-card generative-wc-card generative-tap-zone${cardFlashAnimation ? ' wc-card--flash' : ''}`}
              key={cardFlashAnimation ? `gen-count-${count}` : 'gen-card'}
              style={{
                '--wc-word-size': `${Math.round(36 * rootFontScale)}px`,
                '--wc-cn-size': `${Math.round(34 * rootFontScale)}px`,
              } as CSSProperties}
            >
              <div className="wc-word">{word}</div>
              {!phase2ShowMeaning ? (
                <>
                  <div className="wc-arrow wc-hidden-arrow" aria-hidden="true">↓</div>
                  <div className="wc-hidden-question-row">
                    <span className="wc-hidden-question" aria-hidden="true">?</span>
                  </div>
                </>
              ) : null}
              {phase2ShowMeaning ? (
                <>
                  <div className="wc-arrow" aria-hidden="true">↓</div>
                  <div className="wc-cn">{rootLabel ?? '（未生成）'}</div>
                  {rootParagraph ? (
                    <p className="generative-first-paragraph">{rootParagraph}</p>
                  ) : null}
                  {rootMnemonicText ? (
                    <p className="generative-root-mnemonic">映射助记：{rootMnemonicText}</p>
                  ) : null}
                </>
              ) : null}
            </div>
            {phase2ShowMeaning ? (
              <div className="mm-btn-row generative-phase2-actions">
                {onEditRootMnemonic ? (
                  <button type="button" className="mm-btn" onClick={onEditRootMnemonic}>
                    AI助记·生成元映射
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="generative-count">
              <div className="wc-count-row">
                <span className={`wc-count${count > 0 ? ' is-bump' : ''}`} key={count}>
                  {count} / {clicksRequired}
                </span>
              </div>
              <div className="wc-dots" aria-hidden="true">
                {Array.from({ length: clicksRequired }, (_, index) => (
                  <span
                    key={index}
                    className={`wc-dot${index < count ? ' is-filled' : ''}`}
                  />
                ))}
              </div>
              <div className="mm-caption">点击屏幕任意非按钮位置计数，达到次数进入下一步</div>
            </div>
          </div>
        </div>
      ) : null}

      {phase === 3 ? (
        <div className="generative-scroll">
          <p className="mm-caption">
            代入生成元到各个实际含义的例句，看看是否可以理解各例句中该生成元的真实指代，找出并点击那些不容易理解出真实指代的实际含义（记作 nc）
          </p>
          <div className="mm-caption">
            第 {page + 1} / {totalPages} 屏 · 已选 {selected.length} 个 nc
          </div>
          {pageItems.map((meaning) => {
            const active = selected.includes(meaning.meaningId)
            return (
              <button
                type="button"
                key={meaning.meaningId}
                className={`generative-c${active ? ' is-selected' : ''}`}
                aria-pressed={active}
                onClick={() =>
                  setSelected((prev) =>
                    prev.includes(meaning.meaningId)
                      ? prev.filter((id) => id !== meaning.meaningId)
                      : [...prev, meaning.meaningId],
                  )
                }
              >
                <span className="generative-c-title">
                  {meaning.pos ? `[${meaning.pos}] ` : ''}
                  {meaning.cn}
                  {active ? <span className="mm-badge nc-badge">nc</span> : null}
                </span>
                {meaning.examples?.slice(0, 3).map((example) => (
                  <span className="generative-example" key={example.en}>
                    <span className="generative-example-en">{example.en}</span>
                    <span className="generative-example-cn">{example.cn}</span>
                  </span>
                ))}
              </button>
            )
          })}
          <div className="mm-btn-row">
            <button type="button" className="mm-btn" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              上一屏
            </button>
            <button
              type="button"
              className="mm-btn"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              下一屏
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => {
                onSaveNc(selected)
                setPhase(4)
              }}
            >
              下一步
            </button>
          </div>
        </div>
      ) : null}

      {phase === 4 ? (
        <div className="generative-scroll">
          <p className="mm-caption">请记忆、默背下述生成元到各实际含义（尤其是 nc）的引申关系</p>
          <div className="generative-root" style={{ fontSize: `${Math.round(22 * rootFontScale)}px` }}>
            {word} → {rootLabel ?? '—'}
          </div>
          <div className="generative-text">
            {text?.trim() ? <MarkdownText text={text} /> : <div className="mm-caption">请点击 AI 生成</div>}
          </div>
          <div className="derivation-nc-list">
            <span className="mm-caption">nc：</span>
            {ncMeanings.length === 0 ? <span className="mm-caption">（无）</span> : null}
            {ncMeanings.map((meaning) => (
              <span className="mm-badge nc-badge" key={meaning.meaningId}>
                {meaning.cn}
              </span>
            ))}
          </div>
          {showMermaid ? <MermaidPreview source={mermaid ?? ''} /> : null}
          <button type="button" className="mm-btn mm-btn--primary" onClick={onClose}>
            完成
          </button>
        </div>
      ) : null}
    </div>
  )
}
