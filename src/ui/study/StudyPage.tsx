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
import { useSwipeBack } from './lib/use-swipe-back'
import { applyDailyGoalChange } from '../../app/hooks/useDailyGoal'
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
  const [speaking, setSpeaking] = useState(false)
  const [ratingLocked, setRatingLocked] = useState(false)
  const [rateCooldown, setRateCooldown] = useState(false)
  const speakTimerRef = useRef<number | null>(null)
  const cooldownTimerRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const memoryScrollRef = useRef(0)
  const previousStageRef = useRef(stage)

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
      className={`study-page study-page--${stage}${study.browseBack ? ' study-page--browse' : ''}`}
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
        {...swipe.handlers}
        style={swipe.offset > 0 ? { transform: `translateX(${swipe.offset}px)` } : undefined}
      >
        {stage === 'board' && session ? (
          <BoardStage
            headword={session.word.headword}
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
            phonetic={session.word.phonetic}
            showPhonetic={session.settings.showPhonetic}
            meanings={study.meanings}
            examples={study.examples}
            mnemonics={study.mnemonics}
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

      {stage === 'annotation' ? (
        <ActionBar
          onMemory={actions.openMemory}
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
