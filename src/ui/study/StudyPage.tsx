import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Rating } from '../../core'
import { useStudySession } from './hooks/useStudySession'
import { speakWord, warmUpVoices } from './lib/speech'
import { BoardStage } from './components/BoardStage'
import { AnnotationStage } from './components/AnnotationStage'
import { MemoryStage } from './components/MemoryStage'
import { ActionBar } from './components/ActionBar'
import { CompletionPage } from './components/CompletionPage'
import { StudyTopBar } from './components/StudyTopBar'
import { ConfirmDialog, ActionSheet } from './components/StudyOverlay'
import { QuickSettingsSheet } from './components/QuickSettingsSheet'
import { BackRevertNotice } from './components/BackRevertNotice'
import { AiGeneratePanel } from '../ai/AiGeneratePanel'
import { UserContentEditor } from './components/UserContent'
import { DerivationPanel } from './components/DerivationPanel'
import { useSidePanelSwipe } from './lib/use-side-panel-swipe'
import type { DerivationMapContent } from './components/types'
import type { UserMnemonicType } from './components/types'
import { useSwipeBack } from './lib/use-swipe-back'
import { applyDailyGoalChange } from '../../app/hooks/useDailyGoal'
import {
  generateDerivationMap,
  getDerivationMap,
  listUserMnemonics,
  listUserNotes,
  loadAiConfig,
  saveDerivationMap,
} from '../../data'
import { aiErrorMessage } from '../../app/hooks/aiUi'
import {
  hasBoardShowMeaningPhrasesSetting,
  readBoardShowMeaningPhrases,
} from '../../app/hooks/boardPhrases'
import './styles/study.css'

/**
 * 学习页（/study，沉浸式全屏，无底部 Tab）。
 * 三态在同一路由内切换：白板面 → 注释面 → 记忆 w-c 页 → 注释面 → 评分 → 下一词。
 * 业务流程/持久化都在 useStudySession → core/data；这里只管渲染与页面级交互（确认弹窗/菜单/发音）。
 */
export default function StudyPage() {
  const navigate = useNavigate()

  /* ---------- toast ---------- */
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, 1600)
  }, [])
  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  const study = useStudySession({ onToast: showToast })
  const { session, settings, stage, actions } = study

  /* ---------- 页面级 UI 状态 ---------- */
  const [exitTarget, setExitTarget] = useState<'study' | 'memory' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false)
  const [aiGenerateOpen, setAiGenerateOpen] = useState(false)
  const [confirmUserDelete, setConfirmUserDelete] = useState(false)
  const [derivationPanelOpen, setDerivationPanelOpen] = useState(false)
  const [derivationContents, setDerivationContents] = useState<
    Record<string, DerivationMapContent>
  >({})
  const [derivationAiBusy, setDerivationAiBusy] = useState(false)
  const [derivationAiError, setDerivationAiError] = useState<string | null>(null)
  const [userEditor, setUserEditor] = useState<null | {
    mode: 'note' | 'mnemonic'
    targetLabel: string
    meaningId?: string
    noteId?: string
    mnemonicId?: string
    aiMnemonic?: { meaningId?: string; type: string; text: string }
    initialText: string
    initialType: UserMnemonicType
  }>(null)
  const [speaking, setSpeaking] = useState(false)
  const [ratingLocked, setRatingLocked] = useState(false)
  const [rateCooldown, setRateCooldown] = useState(false)
  const speakTimerRef = useRef<number | null>(null)
  const cooldownTimerRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const panelWordIdRef = useRef<string | null>(null)
  const memoryScrollRef = useRef(0)
  const previousStageRef = useRef(stage)

  const currentWordId = session?.word.wordId ?? null
  useEffect(() => {
    if (panelWordIdRef.current !== currentWordId) {
      panelWordIdRef.current = currentWordId
      setDerivationPanelOpen(false)
    }
  }, [currentWordId])

  useEffect(() => {
    if (!currentWordId) return
    let alive = true
    void getDerivationMap(currentWordId)
      .then((map) => {
        if (!alive || !map) return
        setDerivationContents((prev) => ({
          ...prev,
          [currentWordId]: {
            mode: map.mermaid ? 'mermaid' : 'text',
            text: map.text ?? '',
            mermaid: map.mermaid ?? '',
            ...(map.rootLabel ? { rootLabel: map.rootLabel } : {}),
            ...(map.source ? { source: map.source } : {}),
          },
        }))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [currentWordId])

  const sideSwipe = useSidePanelSwipe({
    enabled: stage === 'annotation',
    open: derivationPanelOpen,
    onOpen: () => setDerivationPanelOpen(true),
    onClose: () => setDerivationPanelOpen(false),
  })

  useEffect(() => {
    warmUpVoices()
    return () => {
      if (speakTimerRef.current != null) window.clearTimeout(speakTimerRef.current)
      if (cooldownTimerRef.current != null) window.clearTimeout(cooldownTimerRef.current)
    }
  }, [])

  /* 进入注释面后 300ms 内禁用评分三键（防误触直接点「认识」，SPEC §4.1 / D13） */
  useEffect(() => {
    if (stage !== 'annotation') return
    setRatingLocked(true)
    const timer = window.setTimeout(() => setRatingLocked(false), 300)
    return () => window.clearTimeout(timer)
  }, [stage, session?.word.wordId])

  /* 记忆页返回注释面时恢复滚动位置（SPEC §4.1 规则 3） */
  useEffect(() => {
    const previous = previousStageRef.current
    previousStageRef.current = stage
    if (stage === 'memory') {
      memoryScrollRef.current = bodyRef.current?.scrollTop ?? 0
      if (bodyRef.current) bodyRef.current.scrollTop = 0
      return
    }
    if (stage === 'annotation' && previous === 'memory') {
      const target = memoryScrollRef.current
      window.requestAnimationFrame(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = target
      })
    }
  }, [stage])

  /* 换词后回到顶部 */
  useEffect(() => {
    if (stage === 'board' && bodyRef.current) bodyRef.current.scrollTop = 0
  }, [stage, session?.word.wordId])

  /* ---------- 返回上一词（plan 驱动：浏览不改状态，点评分才改判） ---------- */
  const canGoBack = study.canGoBack
  const handleGoBack = useCallback(() => {
    void actions.goBack()
  }, [actions])
  const swipe = useSwipeBack({ enabled: canGoBack, onBack: handleGoBack })

  /* ---------- 发音 ---------- */
  const handleSpeak = useCallback(() => {
    const headword = session?.word.headword
    if (!headword) return
    const ok = speakWord(headword)
    if (!ok) {
      showToast('当前浏览器不支持发音')
      return
    }
    setSpeaking(true)
    if (speakTimerRef.current != null) window.clearTimeout(speakTimerRef.current)
    speakTimerRef.current = window.setTimeout(() => setSpeaking(false), 900)
  }, [session?.word.headword, showToast])

  /** 学习页内改每日学习量（task-35）：data resync 后刷新 plan，不打断当前词 */
  const handleDailyGoalChange = useCallback(
    (goal: number) => {
      void applyDailyGoalChange(goal)
        .then(async (outcome) => {
          showToast(outcome.message)
          if (outcome.resynced) {
            // 刷新 plan 数字（当前词/w-c 状态保留，不打断）
            await actions.refreshPlan()
          }
        })
        .catch((error: unknown) =>
          showToast(error instanceof Error ? error.message : '保存失败'),
        )
    },
    [actions, showToast],
  )

  /* ---------- 评分 ---------- */
  const handleRate = useCallback(
    (rating: Rating) => {
      if (ratingLocked || rateCooldown || study.submitting) return
      setRateCooldown(true)
      if (cooldownTimerRef.current != null) window.clearTimeout(cooldownTimerRef.current)
      cooldownTimerRef.current = window.setTimeout(() => setRateCooldown(false), 400)
      void actions.rate(rating)
    },
    [actions, rateCooldown, ratingLocked, study.submitting],
  )

  /* ---------- 退出 / 菜单 ---------- */
  const handleCloseTopBar = useCallback(() => {
    if (stage === 'memory') {
      setExitTarget('memory')
    } else {
      setExitTarget('study')
    }
  }, [stage])

  const handleConfirmExit = useCallback(async () => {
    const target = exitTarget
    setExitTarget(null)
    if (target === 'memory') {
      actions.exitMemory()
      return
    }
    await actions.flushSnapshot()
    navigate('/')
  }, [actions, exitTarget, navigate])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (exitTarget != null || menuOpen || quickSettingsOpen) return
      setExitTarget(stage === 'memory' ? 'memory' : 'study')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [exitTarget, menuOpen, quickSettingsOpen, stage])

  const handleQuitStudy = useCallback(() => {
    setExitTarget('study')
  }, [])

  /* ---------- 完成 / 空状态 ---------- */
  if (study.phase === 'loading') {
    return (
      <div className="study-page">
        <div className="study-loading">正在加载今日学习…</div>
      </div>
    )
  }

  if (study.phase === 'error') {
    return (
      <div className="study-page">
        <div className="study-error">
          <h1 className="study-error-title">学习页加载失败</h1>
          <p className="study-error-message">{study.errorMessage ?? '未知错误'}</p>
          <div className="completion-actions">
            <button
              type="button"
              className="study-btn study-btn--primary"
              onClick={() => void actions.reload()}
            >
              重试
            </button>
            <button type="button" className="study-btn" onClick={() => navigate('/')}>
              回首页
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (study.phase === 'done' || study.phase === 'empty' || study.phase === 'no-deck') {
    const variant = study.phase === 'done' ? 'done' : study.phase === 'empty' ? 'empty' : 'no-deck'
    return (
      <div className="study-page">
        <CompletionPage
          variant={variant}
          learnedCount={study.learnedCount}
          minutes={study.minutes}
          onPrimary={() => navigate(variant === 'done' ? '/stats' : '/decks')}
          onSecondary={() => navigate('/')}
        />
      </div>
    )
  }

  /* ---------- 学习中 ---------- */
  const isMemory = stage === 'memory'
  const topTitle = isMemory
    ? `${study.memoryProgress.completed} / ${study.memoryProgress.total} 个含义`
    : `${study.progress.index} / ${study.progress.total}`
  const topProgress = isMemory ? study.memoryProgress.fraction : study.progress.fraction
  const memoryShowPhrases = session?.settings.showPhrases ?? settings?.['memory.showPhrases'] ?? true
  const fontScale = settings?.['memory.fontScale'] ?? 1
  const cardSize = settings?.['memory.cardSize'] ?? 1
  const ratingDisabled = study.submitting || ratingLocked || rateCooldown

  const menuItems = [
    {
      label: 'AI 补内容（当前词/当前 c）',
      onSelect: () => setAiGenerateOpen(true),
    },
    {
      label: '记忆设置',
      onSelect: () => setQuickSettingsOpen(true),
    },
    ...(isMemory
      ? [{ label: '退出记忆', danger: true, onSelect: () => setExitTarget('memory') }]
      : [{ label: '退出学习', danger: true, onSelect: handleQuitStudy }]),
  ]

  return (
    <div
      className={`study-page study-page--${stage}${study.browseBack ? ' study-page--browse' : ''}${derivationPanelOpen ? ' study-page--side' : ''}`}
    >
      <StudyTopBar
        title={topTitle}
        progress={topProgress}
        onClose={handleCloseTopBar}
        onMenu={() => setMenuOpen(true)}
        closeLabel={isMemory ? '退出记忆' : '退出学习'}
        onBack={canGoBack ? handleGoBack : undefined}
      />

      <div
        className={`study-body${swipe.dragging ? ' is-swiping' : ''}`}
        ref={bodyRef}
        onPointerDown={(event) => {
          swipe.handlers.onPointerDown(event)
          sideSwipe.onPointerDown(event)
        }}
        onPointerMove={swipe.handlers.onPointerMove}
        onPointerUp={(event) => {
          swipe.handlers.onPointerUp(event)
          sideSwipe.onPointerUp(event)
        }}
        onPointerCancel={(event) => {
          swipe.handlers.onPointerCancel(event)
          sideSwipe.onPointerCancel()
        }}
        style={swipe.offset > 0 ? { transform: `translateX(${swipe.offset}px)` } : undefined}
      >
        {stage === 'board' && session ? (
          <BoardStage
            headword={session.word.headword}
            meanings={study.meanings.map((meaning) => ({
              pos: meaning.pos,
              examples: meaning.examples,
              meaningId: meaning.meaningId,
            }))}
            showMeaningPhrases={
              hasBoardShowMeaningPhrasesSetting(settings) &&
              readBoardShowMeaningPhrases(settings)
            }
            phrases={(session.word.phrases as unknown as Array<{ en: string; meaningId?: string }>).map((phrase) => ({
              en: phrase.en,
              ...(phrase.meaningId ? { meaningId: phrase.meaningId } : {}),
            }))}
            phonetic={session.word.phonetic}
            showPhonetic={session.settings.showPhonetic}
            examples={study.examples}
            exampleCount={session.settings.exampleCount}
            speaking={speaking}
            onSpeak={handleSpeak}
            onNext={() => void actions.boardTap()}
          />
        ) : null}

        {stage === 'annotation' && session ? (
          <AnnotationStage
            headword={session.word.headword}
            coreSenses={study.coreSenses}
            phonetic={session.word.phonetic}
            showPhonetic={session.settings.showPhonetic}
            meanings={study.meanings}
            examples={study.examples}
            mnemonics={study.mnemonics}
            userNotes={study.userNotes}
            userMnemonics={study.userMnemonics}
            onEditUserNote={(target) => {
              void (async () => {
                const wordId = session.word.wordId
                const existing = (
                  await listUserNotes(wordId, target.meaningId ?? undefined).catch(() => [])
                )[0]
                setUserEditor({
                  mode: 'note',
                  targetLabel: target.meaningId ? `c：${target.meaningCn ?? ''}` : session.word.headword,
                  ...(target.meaningId ? { meaningId: target.meaningId } : {}),
                  ...(existing ? { noteId: existing.id } : {}),
                  initialText: existing?.text ?? '',
                  initialType: '联想',
                })
              })()
            }}
            onEditUserMnemonic={(target) => {
              void (async () => {
                const wordId = session.word.wordId
                const existing = (
                  await listUserMnemonics(wordId, target.meaningId ?? undefined).catch(() => [])
                )[0]
                setUserEditor({
                  mode: 'mnemonic',
                  targetLabel: target.meaningId ? `c：${target.meaningCn ?? ''}` : session.word.headword,
                  ...(target.meaningId ? { meaningId: target.meaningId } : {}),
                  ...(existing ? { mnemonicId: existing.id } : {}),
                  initialText: existing?.text ?? '',
                  initialType: (existing?.type as UserMnemonicType) ?? '联想',
                })
              })()
            }}
            onEditMnemonic={(target) => {
              setUserEditor({
                mode: 'mnemonic',
                targetLabel: target.meaningId ? `c：${target.meaningCn ?? ''}` : session.word.headword,
                ...(target.meaningId ? { meaningId: target.meaningId } : {}),
                aiMnemonic: target.mnemonic,
                initialText: target.mnemonic.text,
                initialType: target.mnemonic.type as UserMnemonicType,
              })
            }}
            phrases={session.word.phrases}
            showPhrases
            speaking={speaking}
            onSpeak={handleSpeak}
            onMarkMeaning={(meaningId) => void actions.markMeaning(meaningId)}
          />
        ) : null}

        {stage === 'memory' && session ? (
          <MemoryStage
            headword={session.word.headword}
            derivation={study.memoryDerivation}
            examples={study.memoryExamples}
            mnemonics={study.memoryMnemonics}
            familiarity={study.memoryFamiliarity}
            unfamiliarityRank={study.memoryRank}
            userNotes={study.memoryUserNotes}
            userMnemonics={study.memoryUserMnemonics}
            meaningCn={study.activeMeaningCn ?? ''}
            count={study.memoryCount}
            total={study.memoryTotal}
            phraseLines={study.memoryPhrases}
            showPhrases={memoryShowPhrases}
            fontScale={fontScale}
            cardSize={cardSize}
            onTap={actions.memoryTap}
          />
        ) : null}
      </div>

      {stage === 'annotation' && session ? (
        <>
          {!derivationPanelOpen ? (
            <button
              type="button"
              className="derivation-handle"
              aria-label="展开生成元引申"
              onClick={() => setDerivationPanelOpen(true)}
            >
              ‹ 引申
            </button>
          ) : null}
          <DerivationPanel
            open={derivationPanelOpen}
            headword={session.word.headword}
            content={
              derivationContents[session.word.wordId] ?? {
                mode: 'text',
                text: study.coreSenses.length
                  ? `生成元（本义）→ 各含义\n\n${study.coreSenses
                      .map((sense, index) => `${index + 1}. ${sense.label}`)
                      .join('\n')}`
                  : '暂无引申内容：点「编辑」或「AI 生成」。',
                mermaid: '',
              }
            }
            onClose={() => {
              setDerivationPanelOpen(false)
              setDerivationAiError(null)
            }}
            saving={derivationAiBusy}
            aiBusy={derivationAiBusy}
            aiError={derivationAiError}
            onSave={(content) => {
              void (async () => {
                try {
                  const saved = await saveDerivationMap(session.word.wordId, {
                    ...(content.rootLabel ? { rootLabel: content.rootLabel } : {}),
                    text: content.text,
                    mermaid: content.mermaid,
                    source: content.source === 'ai' ? 'ai' : 'manual',
                  })
                  setDerivationContents((prev) => ({
                    ...prev,
                    [session.word.wordId]: {
                      mode: content.mode,
                      text: saved.text ?? content.text,
                      mermaid: saved.mermaid ?? content.mermaid,
                      ...(saved.rootLabel ? { rootLabel: saved.rootLabel } : {}),
                      source: saved.source ?? content.source ?? 'manual',
                    },
                  }))
                  showToast('已保存引申内容')
                } catch (error) {
                  showToast(error instanceof Error ? error.message : '保存引申内容失败')
                }
              })()
            }}
            onAiGenerate={() => {
              void (async () => {
                setDerivationAiBusy(true)
                setDerivationAiError(null)
                try {
                  const config = await loadAiConfig()
                  if (!config.apiKey) throw Object.assign(new Error('未配置 Key'), { code: 'AI_NO_KEY' })
                  const meanings = session.word.meanings.map((meaning, index) => ({
                    index: index + 1,
                    cn: meaning.cn,
                    ...(meaning.pos ? { pos: meaning.pos } : {}),
                  }))
                  const result = await generateDerivationMap(
                    {
                      word: session.word.headword,
                      coreSenses: study.coreSenses.map((sense) => ({
                        label: sense.label,
                        ...(sense.note ? { note: sense.note } : {}),
                      })),
                      meanings,
                    },
                    config,
                  )
                  setDerivationContents((prev) => ({
                    ...prev,
                    [session.word.wordId]: {
                      mode: result.mermaid ? 'mermaid' : 'text',
                      text: result.text ?? '',
                      mermaid: result.mermaid ?? '',
                      rootLabel: result.rootLabel,
                      source: 'ai',
                    },
                  }))
                  showToast('AI 引申图已生成预览：确认后点「保存」写入')
                } catch (error) {
                  const code = (error as { code?: string })?.code
                  setDerivationAiError(aiErrorMessage(code, 'AI 生成引申图失败'))
                } finally {
                  setDerivationAiBusy(false)
                }
              })()
            }}
          />
        </>
      ) : null}

      {stage === 'annotation' ? (
        <ActionBar
          onMemory={actions.openMemory}
          onWeightedMemory={stage === 'annotation' ? actions.openWeightedMemory : undefined}
          onRate={handleRate}
          labels={study.ratingLabels}
          nextHints={study.nextHints}
          highlighted={study.browseBack ? study.lastChoice : null}
          notice={
            study.browseBack ? (
              <BackRevertNotice
                rating={study.lastChoice}
                onContinue={() => void actions.continueForward()}
              />
            ) : null
          }
          ratingDisabled={ratingDisabled}
        />
      ) : null}

      {toast ? (
        <div className="study-toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}

      {menuOpen ? <ActionSheet items={menuItems} onClose={() => setMenuOpen(false)} /> : null}

      {confirmUserDelete ? (
      <ConfirmDialog
        title="删除我的内容？"
        body="将删除这条「我的」笔记/助记（AI 原条目仅隐藏，AI 包数据不删除）。"
        confirmLabel="删除"
        danger
        onCancel={() => setConfirmUserDelete(false)}
        onConfirm={() => {
          void (async () => {
            try {
              if (userEditor?.noteId) await actions.deleteUserNoteById(userEditor.noteId)
              else if (userEditor?.mnemonicId)
                await actions.deleteUserMnemonicById(userEditor.mnemonicId)
              else if (userEditor?.aiMnemonic) await actions.hideAiMnemonic(userEditor.aiMnemonic)
              setConfirmUserDelete(false)
              setUserEditor(null)
              showToast('已删除')
            } catch (error) {
              showToast(error instanceof Error ? error.message : '删除失败')
            }
          })()
        }}
      />
      ) : null}

      <UserContentEditor
        key={
          userEditor
            ? `${userEditor.mode}:${userEditor.meaningId ?? 'w'}:${userEditor.noteId ?? userEditor.mnemonicId ?? 'new'}:${userEditor.aiMnemonic?.text ?? ''}`
            : 'closed'
        }
        open={userEditor != null}
        targetLabel={userEditor?.targetLabel ?? ''}
        mode={userEditor?.mode ?? 'note'}
        initialText={userEditor?.initialText ?? ''}
        initialType={userEditor?.initialType ?? '联想'}
        onClose={() => setUserEditor(null)}
        onDelete={
          userEditor && (userEditor.noteId || userEditor.mnemonicId || userEditor.aiMnemonic)
            ? () => setConfirmUserDelete(true)
            : undefined
        }
        onSave={(input) => {
          void (async () => {
            try {
              if (!userEditor) return
              if (userEditor.mode === 'note') {
                await actions.saveUserNote({
                  ...(userEditor.noteId ? { id: userEditor.noteId } : {}),
                  text: input.text,
                  ...(userEditor.meaningId ? { meaningId: userEditor.meaningId } : {}),
                })
              } else {
                await actions.saveUserMnemonic({
                  ...(userEditor.mnemonicId ? { id: userEditor.mnemonicId } : {}),
                  type: (input.type ?? userEditor.initialType) as UserMnemonicType,
                  text: input.text,
                  ...(userEditor.meaningId ? { meaningId: userEditor.meaningId } : {}),
                })
                if (userEditor.aiMnemonic) {
                  await actions.hideAiMnemonic(userEditor.aiMnemonic)
                }
              }
              setUserEditor(null)
              showToast('已保存（我的）')
            } catch (error) {
              showToast(error instanceof Error ? error.message : '保存失败')
            }
          })()
        }}
      />

      <AiGeneratePanel
        open={aiGenerateOpen}
        initialScope={session ? 'word' : 'today'}
        currentWordId={session?.word.wordId}
        onClose={() => setAiGenerateOpen(false)}
        onApplied={() => void actions.reloadCurrentWord()}
      />

      {quickSettingsOpen && settings ? (
        <QuickSettingsSheet
          settings={settings}
          onPatch={(patch) => void actions.updateStudySettings(patch)}
          onDailyGoalChange={handleDailyGoalChange}
          onClose={() => setQuickSettingsOpen(false)}
        />
      ) : null}

      {exitTarget === 'memory' ? (
        <ConfirmDialog
          title="退出记忆？"
          body="已完成部分会保留，下次进入记忆可继续。"
          cancelLabel="继续记忆"
          confirmLabel="退出记忆"
          danger
          onCancel={() => setExitTarget(null)}
          onConfirm={() => void handleConfirmExit()}
        />
      ) : null}

      {exitTarget === 'study' ? (
        <ConfirmDialog
          title="退出学习？"
          body="今天的进度会自动保存，下次可继续。"
          cancelLabel="继续学习"
          confirmLabel="退出"
          danger
          onCancel={() => setExitTarget(null)}
          onConfirm={() => void handleConfirmExit()}
        />
      ) : null}
    </div>
  )
}
