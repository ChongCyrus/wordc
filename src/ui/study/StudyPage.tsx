import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Rating } from '../../core'
import { useStudySession } from './hooks/useStudySession'
import { speakWord, warmUpVoices } from './lib/speech'
import { BoardStage } from './components/BoardStage'
import { AnnotationStage } from './components/AnnotationStage'
import { MemoryStage } from './components/MemoryStage'
import { ActionBar } from './components/ActionBar'
import { CompletionPage } from './components/CompletionPage'
import { useLiveQuery } from 'dexie-react-hooks'
import { StudyTopBar } from './components/StudyTopBar'
import { RootEtymologyCard } from './components/RootEtymologyCard'
import { RootEtymologyEditDialog } from './components/RootEtymologyEditDialog'
import { TempReviewSummaryView } from './components/TempReviewSummaryView'
import { ConfirmDialog, ActionSheet } from './components/StudyOverlay'
import { QuickSettingsSheet } from './components/QuickSettingsSheet'
import { BackRevertNotice } from './components/BackRevertNotice'
import { AiGeneratePanel } from '../ai/AiGeneratePanel'
import { UserContentEditor } from './components/UserContent'
import { SubwordDialog, type SubwordMeaning } from './components/SubwordDialog'
import {
  GenerativeMemoryStage,
  extractRootParagraph,
} from './components/GenerativeMemoryStage'
import { RootMnemonicDialog } from './components/RootMnemonicDialog'
import { RareMeaningsPreviewDialog } from './components/RareMeaningsPreviewDialog'
import { SenseMnemonicPanel } from './components/SenseMnemonicPanel'
import { SenseMnemonicEditDialog } from './components/SenseMnemonicEditDialog'
import { CoreSenseOverviewEditDialog } from './components/CoreSenseOverviewEditDialog'
import { CoreSenseAIPanel } from './components/CoreSenseAIPanel'
import { readGenerativeSettings } from '../../app/hooks/generativeSettings'
import { DerivationPanel } from './components/DerivationPanel'
import { useStudyPanelGesture } from './lib/use-study-panel-gesture'
import { readDerivationMarkdown } from './lib/derivation-markdown'
import { mergeGeneratedDerivation } from './lib/derivation-map'
import { generativeMeaningsForStage3 } from './lib/generative-meanings'
import type { DerivationMapContent } from './components/types'
import type { UserMnemonicType } from './components/types'
import { applyDailyGoalChange } from '../../app/hooks/useDailyGoal'
import {
  buildDerivationJson,
  findSubwordMeanings,
  generateDerivationMap,
  getDerivationMap,
  getNcMeaningIds,
  getRootEtymology,
  getCoreSenseOverview,
  getRareCoreSenseIndexes,
  getRareMeaningIds,
  listRareCoreSenseViews,
  setRareCoreSenseIndexes,
  getRootMnemonic,
  listSenseMnemonicViews,
  generateRareMeanings,
  generateRootMnemonic,
  saveRootMnemonic,
  setRareMeaningIds as saveRareMeaningIds,
  listUserMnemonics,
  resolveCoreSenseStatKey,
  listUserNotes,
  loadAiConfig,
  parseDerivationJson,
  saveDerivationMap,
  setNcMeaningIds as saveNcMeaningIds,
  deleteWord,
} from '../../data'
import { aiErrorMessage } from '../../app/hooks/aiUi'
import { useSettings } from '../../app/hooks/useSettings'
import {
  coreSenseFamiliarity,
  memoryShowMeaning,
  memorySummaryEntries,
  memoryViewPhase,
} from '../../core'
import {
  hasBoardShowMeaningPhrasesSetting,
  readBoardShowMeaningPhrases,
} from '../../app/hooks/boardPhrases'
import './styles/study.css'

import {
  DERIVATION_WIDTH_DEFAULT,
  DERIVATION_WIDTH_MAX,
  DERIVATION_WIDTH_MIN,
  derivationWidthFromDrag,
  clampLiveDerivationWidth,
  readSwipeSensitivity,
} from './lib/derivation-width'
import { registerNativeBack } from './lib/native-back'

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

  const [studySearchParams] = useSearchParams()
  const detailWordId = studySearchParams.get('detailWord') ?? undefined
  const detailReturnTo = studySearchParams.get('returnTo') ?? '/'
  const detailMode = Boolean(detailWordId)
  const tempWordIds = (studySearchParams.get('tempWords') ?? '').split(',').filter(Boolean)
  const tempRecordMode = (studySearchParams.get('tempRecordMode') ?? 'rate') as
    | 'practice'
    | 'rate'
    | 'rate-only'
  const tempAutoRequeue = studySearchParams.get('autoRequeue') === '1'
  const tempReturnTo = studySearchParams.get('returnTo') ?? '/'
  const tempMode = tempWordIds.length > 0
  const study = useStudySession({
    onToast: showToast,
    detailWordId,
    detailReturnTo,
    tempWordIds: tempMode ? tempWordIds : undefined,
    tempRecordMode,
    tempAutoRequeue,
  })
  const { settings: appSettings } = useSettings()
  const markRareCoreSenses = appSettings?.['study.markRareCoreSenses'] !== false
  const hideRareBlocks = appSettings?.['study.hideRareBlocks'] !== false
  const { session, settings, stage, actions } = study
  const stageRef = useRef(stage)
  const ignoreNextPopRef = useRef(false)
  const actionsRef = useRef(actions)
  stageRef.current = stage
  actionsRef.current = actions
  const rootEtymology = useLiveQuery(
    () => (session?.word.wordId ? getRootEtymology(session.word.wordId) : Promise.resolve(null)),
    [session?.word.wordId],
  )

  /* ---------- 页面级 UI 状态 ---------- */
  const [exitTarget, setExitTarget] = useState<'study' | 'memory' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false)
  const [aiGenerateOpen, setAiGenerateOpen] = useState(false)
  const [confirmUserDelete, setConfirmUserDelete] = useState(false)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const [derivationPanelOpen, setDerivationPanelOpen] = useState(false)
  const [derivationPanelFullscreen, setDerivationPanelFullscreen] = useState(false)
  const [derivationWidth, setDerivationWidth] = useState(DERIVATION_WIDTH_DEFAULT)
  const derivationDragRef = useRef<null | { startX: number; startWidth: number; vw: number }>(null)
  const [derivationContents, setDerivationContents] = useState<
    Record<string, DerivationMapContent>
  >({})
  const [derivationAiBusy, setDerivationAiBusy] = useState(false)
  const [derivationAiError, setDerivationAiError] = useState<string | null>(null)
  const [derivationMode, setDerivationMode] = useState<'text' | 'mermaid'>('text')
  const [derivationUsageOpen, setDerivationUsageOpen] = useState(false)
  const [derivationViewerOpen, setDerivationViewerOpen] = useState(false)
  const [sensePanelOpen, setSensePanelOpen] = useState(false)
  const [senseEditIndex, setSenseEditIndex] = useState<number | null>(null)
  const [senseEditDialog, setSenseEditDialog] = useState<null | {
    coreSenseIndex: number
    label: string
    text: string
  }>(null)
  const [coreSenseAiOpen, setCoreSenseAiOpen] = useState(false)
  const [overviewEditOpen, setOverviewEditOpen] = useState(false)
  const [rootEtymologyEditOpen, setRootEtymologyEditOpen] = useState(false)
  const [derivationSaving, setDerivationSaving] = useState(false)
  const [ncMeaningIds, setNcMeaningIds] = useState<string[]>([])
  const [rareMeaningIds, setRareMeaningIds] = useState<string[]>([])
  const [rareCoreSenseIndexes, setRareCoreSenseIndexesState] = useState<number[]>([])

  const [rareCoreSenseStale, setRareCoreSenseStale] = useState<Array<{ coreSenseIndex: number; label: string; updatedAt: number }>>([])
  const [pendingRareCoreCancel, setPendingRareCoreCancel] = useState<null | { coreSenseIndex: number; label: string }>(null)
  const [rootMnemonicText, setRootMnemonicText] = useState('')
  const [rootMnemonicOpen, setRootMnemonicOpen] = useState(false)
  const [rootMnemonicBusy, setRootMnemonicBusy] = useState(false)
  const [rootMnemonicError, setRootMnemonicError] = useState<string | null>(null)
  const [rootMnemonicSaveStatus, setRootMnemonicSaveStatus] = useState<string | null>(null)
  const [rootMnemonicCandidates, setRootMnemonicCandidates] = useState<string[]>([])
  const [rarePreviewOpen, setRarePreviewOpen] = useState(false)
  const [rarePreviewItems, setRarePreviewItems] = useState<
    Array<{ meaningId: string; pos?: string; cn: string }>
  >([])
  const [rarePreviewSelected, setRarePreviewSelected] = useState<string[]>([])
  const [rareCorePreviewItems, setRareCorePreviewItems] = useState<
    Array<{ coreSenseIndex: number; label: string; cn?: string }>
  >([])
  const [rareCorePreviewSelected, setRareCorePreviewSelected] = useState<number[]>([])
  const [rareAiBusy, setRareAiBusy] = useState(false)
  const [rareAiError, setRareAiError] = useState<string | null>(null)
  const [coreSenseOverview, setCoreSenseOverview] = useState<string | null>(null)
  const [senseMnemonics, setSenseMnemonics] = useState<
    Array<{ coreSenseIndex: number; label: string; text: string; source: 'manual' | 'ai' }>
  >([])
  const [subwords, setSubwords] = useState<SubwordMeaning[] | null>(null)
  const [subwordLoading, setSubwordLoading] = useState(false)
  const [generativeOpen, setGenerativeOpen] = useState(false)
  const [generativeSaveStatus, setGenerativeSaveStatus] = useState<string | null>(null)
  const [generativeSettings] = useState(readGenerativeSettings)
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
      setDerivationPanelFullscreen(false)
      setDerivationViewerOpen(false)
    }
  }, [currentWordId])


  useEffect(() => {
    if (!currentWordId) return
    let alive = true
    void getNcMeaningIds(currentWordId)
      .then((ids) => {
        if (alive) setNcMeaningIds(ids)
      })
      .catch(() => undefined)
    void getRareMeaningIds(currentWordId)
      .then((ids) => {
        if (alive) setRareMeaningIds(ids)
      })
      .catch(() => undefined)
    void getRareCoreSenseIndexes(currentWordId)
      .then((indexes) => {
        if (alive) setRareCoreSenseIndexesState(indexes)
      })
      .catch(() => undefined)
    void listRareCoreSenseViews(currentWordId)
      .then((views) => {
        if (alive) setRareCoreSenseStale(views.stale)
      })
      .catch(() => undefined)
    void listSenseMnemonicViews(currentWordId)
      .then((views) => {
        if (!alive) return
        setSenseMnemonics(
          views.current
            .filter((view) => view.mnemonic)
            .map((view) => ({
              coreSenseIndex: view.coreSenseIndex,
              label: view.label,
              text: view.mnemonic!.text,
              source: view.mnemonic!.source,
            })),
        )
      })
      .catch(() => undefined)
    void getCoreSenseOverview(currentWordId)
      .then((overview) => {
        if (alive) setCoreSenseOverview(overview?.text ?? null)
      })
      .catch(() => undefined)
    void getRootMnemonic(currentWordId)
      .then((entry) => {
        if (alive) setRootMnemonicText(entry?.text ?? '')
      })
      .catch(() => undefined)
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
            ...(map.lines?.length ? { lines: map.lines } : {}),
            ...(map.source ? { source: map.source } : {}),
          },
        }))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [currentWordId])

  // task-184：原生 touch + 方向锁 + 打开/调宽两阶段的右页手势（接线见 lib/use-study-panel-gesture）
  useStudyPanelGesture({
    // task-185：用页面根容器做手势捕获（覆盖右侧空白/无 class 的容器），
    // 全屏右页/弹层打开时禁用手势，避免误调宽。
    enabled:
      stage === 'annotation' &&
      !derivationPanelFullscreen &&
      !derivationUsageOpen &&
      !derivationViewerOpen &&
      !generativeOpen,
    containerRef: pageRef,
    isOpen: derivationPanelOpen,
    widthPercent: derivationWidth,
    sensitivity: readSwipeSensitivity(settings),
    onOpen: (widthPercent) => {
      setDerivationPanelOpen(true)
      setDerivationMode('text')
      setDerivationPanelFullscreen(false)
      setDerivationWidth(clampLiveDerivationWidth(widthPercent))
    },
    onClose: () => setDerivationPanelOpen(false),
    onResize: (percent) => setDerivationWidth(clampLiveDerivationWidth(percent)),
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
  }, [actions, detailMode, detailReturnTo, navigate, stage, tempMode, tempReturnTo])

  /* 换词后回到顶部 */
  useEffect(() => {
    if (stage === 'board' && bodyRef.current) bodyRef.current.scrollTop = 0
  }, [stage, session?.word.wordId])

  /* ---------- 返回上一词（plan 驱动：浏览不改状态，点评分才改判） ---------- */
  const canGoBack = study.canGoBack
  const handleGoBack = useCallback(() => {
    void actions.goBack()
  }, [actions])

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
    if (tempMode) {
      navigate(tempReturnTo)
      return
    }
    if (detailMode) {
      if (stage === 'memory') {
        actions.exitMemory()
        return
      }
      // 立即返回，快照后台刷新，避免卡在 loading/被首启导入阻塞
      navigate(detailReturnTo)
      void actions.flushSnapshot().catch(() => undefined)
      return
    }
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

  // 0.3.98：浏览器/PWA 返回键在 w-c 页也回注释面（只挂载一次，handler 用 ref 取最新 stage/actions）
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (ignoreNextPopRef.current) {
        ignoreNextPopRef.current = false
        event.stopImmediatePropagation()
        return
      }
      if (stageRef.current !== 'memory') return
      event.stopImmediatePropagation()
      // 这次 back 已消费哨兵，保留 /study 原历史，不再压新哨兵
      actionsRef.current.exitMemory()
    }
    window.addEventListener('popstate', onPopState, true)
    return () => window.removeEventListener('popstate', onPopState, true)
  }, [])

  // 进入 memory 时压一条同 URL 哨兵历史；不在 cleanup 里 back，避免反复弹历史
  useEffect(() => {
    if (stage === 'memory') {
      try {
        window.history.pushState({ momoWcBack: true }, '', window.location.href)
      } catch {
        /* 忽略 history 失败 */
      }
    } else if ((window.history.state as { momoWcBack?: boolean } | null)?.momoWcBack) {
      try {
        // UI 正常退出记忆：消费掉哨兵历史；忽略这次 pop，不再 exitMemory
        ignoreNextPopRef.current = true
        window.history.back()
      } catch {
        ignoreNextPopRef.current = false
      }
    }
  }, [stage])

  useEffect(() => {
    const unregister = registerNativeBack(() => {
      if (generativeOpen) {
        setGenerativeOpen(false)
        return true
      }
      if (subwords != null || subwordLoading) {
        setSubwords(null)
        setSubwordLoading(false)
        return true
      }
      if (userEditor) {
        setUserEditor(null)
        return true
      }
      if (confirmUserDelete) {
        setConfirmUserDelete(false)
        return true
      }
      if (derivationUsageOpen) {
        setDerivationUsageOpen(false)
        return true
      }
      if (derivationPanelOpen) {
        if (derivationPanelFullscreen) {
          setDerivationPanelFullscreen(false)
          return true
        }
        setDerivationPanelOpen(false)
        setDerivationUsageOpen(false)
        return true
      }
      // 0.3.98：w-c 记忆页系统返回键 = 退出记忆回注释面（不再继续回首页）
      if (stage === 'memory') {
        actions.exitMemory()
        return true
      }
      return false
    })
    return unregister
  }, [
    actions,
    confirmUserDelete,
    derivationPanelFullscreen,
    derivationPanelOpen,
    derivationUsageOpen,
    generativeOpen,
    subwordLoading,
    stage,
    subwords,
    userEditor,
  ])


  /* ---------- 完成 / 空状态 ---------- */
  if (tempMode && study.tempSummary) {
    return (
      <TempReviewSummaryView
        summary={study.tempSummary}
        totalWords={study.tempTotalWords}
        skipped={study.tempSkipped}
        onBack={() => navigate(tempReturnTo)}
        onApply={study.tempSession ? actions.applyTempToDhp : undefined}
      />
    )
  }

  if (study.phase === 'loading') {
    return (
      <div className="study-page">
        <div className="study-loading">正在加载今日学习…</div>
        {detailMode || tempMode ? (
          <div className="completion-actions">
            <button
              type="button"
              className="study-btn"
              onClick={() => navigate(detailMode ? detailReturnTo : tempReturnTo)}
            >
              返回
            </button>
          </div>
        ) : null}
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
            <button
              type="button"
              className="study-btn"
              onClick={() =>
                navigate(detailMode ? detailReturnTo : tempMode ? tempReturnTo : '/')
              }
            >
              {detailMode || tempMode ? '返回' : '回首页'}
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
  const topTitle = tempMode
    ? `临时复习 ${session?.word.headword ?? ''}`
    : detailMode
    ? `${session?.word.headword ?? ''}`
    : isMemory
      ? `${study.memoryProgress.completed} / ${study.memoryProgress.total} 个含义`
      : `${study.progress.index} / ${study.progress.total}`
  const topProgress = tempMode ? 1 : detailMode ? 1 : isMemory ? study.memoryProgress.fraction : study.progress.fraction
  const memoryShowPhrases = session?.settings.showPhrases ?? settings?.['memory.showPhrases'] ?? true
  const fontScale = settings?.['memory.fontScale'] ?? 1
  const cardSize = settings?.['memory.cardSize'] ?? 1
  const ratingDisabled = study.submitting || ratingLocked || rateCooldown

  const menuItems = [
    ...(detailMode
      ? [
          {
            label: '编辑词条',
            onSelect: () => navigate(`${detailReturnTo}?edit=${encodeURIComponent(session?.word.wordId ?? '')}`),
          },
          {
            label: '删除词条',
            danger: true,
            onSelect: () => {
              if (!session?.word.wordId) return
              if (!window.confirm('删除该词条？该操作不可撤销。')) return
              void deleteWord(session.word.wordId).then(() => navigate(detailReturnTo, { replace: true }))
            },
          },
        ]
      : []),
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
      ref={pageRef}
      className={`study-page study-page--${stage}${study.browseBack ? ' study-page--browse' : ''}${derivationPanelOpen ? ' study-page--side' : ''}${derivationPanelFullscreen ? ' study-page--side-full' : ''}`}
      style={{ '--derivation-panel-width': `${derivationWidth}%` } as Record<string, string>}
    >
      {isMemory ? (
        <div className="memory-top-stack">
          <label className="memory-3tap-toggle">
            <input
              type="checkbox"
              checked={appSettings?.['memory.threeTapRecall'] !== false}
              onChange={(event) => {
                const next = event.target.checked
                void study.actions.updateStudySettings({ 'memory.threeTapRecall': next })
              }}
            />
            <span>三小次模式</span>
          </label>
          {session?.weightedTotals ? (
            <label className="weighted-core-only-toggle">
              <input
                type="checkbox"
                checked={appSettings?.['memory.weightedCoreSenseOnly'] === true}
                onChange={(event) => {
                  const next = event.target.checked
                  void study.actions.switchWeightedCoreOnly(next)
                }}
              />
              <span>只记本义</span>
            </label>
          ) : null}
          {study.activeCoreSense ? (
            <button type="button" className="core-sense-ai-btn" onClick={() => setCoreSenseAiOpen(true)}>
              AI 本义内容
            </button>
          ) : null}
        </div>
      ) : null}
      <StudyTopBar
        title={topTitle}
        progress={topProgress}
        onClose={handleCloseTopBar}
        onMenu={() => setMenuOpen(true)}
        closeLabel={tempMode ? '退出临时复习' : detailMode ? '返回详情' : isMemory ? '退出记忆' : '退出学习'}
        onBack={detailMode ? undefined : canGoBack ? handleGoBack : undefined}
      />

      <div
        className="study-body"
        ref={bodyRef}
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
            phrases={((session.word.phrases ?? []) as unknown as Array<{ en: string; meaningId?: string }>).map((phrase) => ({
              en: phrase.en,
              ...(phrase.meaningId ? { meaningId: phrase.meaningId } : {}),
            }))}
            phonetic={session.word.phonetic}
            showPhonetic={session.settings.showPhonetic}
            examples={study.examples}
            ncMeanings={session.word.meanings
              .filter((meaning) => ncMeaningIds.includes(meaning.meaningId))
              .map((meaning) => ({
                ...(meaning.pos ? { pos: meaning.pos } : {}),
                cn: meaning.cn,
              }))}
            exampleCount={session.settings.exampleCount}
            speaking={speaking}
            onSpeak={handleSpeak}
            onNext={() => void actions.boardTap()}
          />
        ) : null}

        {stage === 'annotation' && session ? (
          <div
            className={derivationPanelOpen ? 'study-annotation-wrap is-side' : 'study-annotation-wrap'}
            style={
              derivationPanelOpen && derivationPanelFullscreen
                ? { display: 'none' }
                : undefined
            }
          >
          {appSettings?.['study.showRootEtymology'] !== false ? (
            <RootEtymologyCard
              data={(rootEtymology as never) ?? null}
              onEdit={() => setRootEtymologyEditOpen(true)}
            />
          ) : null}
          <AnnotationStage
            headword={session.word.headword}
            coreSenses={study.coreSenses}
            coreSenseOverview={coreSenseOverview}
            onEditCoreSenseOverview={() => setOverviewEditOpen(true)}
            coreSenseStatsByIndex={Object.fromEntries(
              study.coreSenses.map((sense, index) => {
                const statKey = resolveCoreSenseStatKey(study.coreSenseStats, {
                  index: index + 1,
                  label: sense.label,
                })
                const stat = statKey ? study.coreSenseStats[statKey] : undefined
                return [index + 1, stat ? { clicks: stat.clicks, encounters: stat.encounters } : { clicks: 0, encounters: 0 }]
              }),
            )}
            coreSenseFamiliarityByIndex={Object.fromEntries(
              study.coreSenses.map((sense, index) => [
                index + 1,
                coreSenseFamiliarity(study.coreSenseStats, { index: index + 1, label: sense.label }),
              ]),
            )}
            onCoreSenseClick={(coreSenseIndex, label) => {
              void study.actions.markCoreSense(coreSenseIndex, label)
            }}
            phonetic={session.word.phonetic}
            showPhonetic={session.settings.showPhonetic}
            meanings={study.meanings}
            examples={study.examples}
            mnemonics={study.mnemonics}
            ncMeaningIds={ncMeaningIds}
            rootLabel={derivationContents[session.word.wordId]?.rootLabel}
            rootParagraph={extractRootParagraph(derivationContents[session.word.wordId]?.text)}
            rootMnemonicText={rootMnemonicText}
            onEditRootMnemonic={() => {
              setRootMnemonicError(null)
              setRootMnemonicSaveStatus(null)
              setRootMnemonicCandidates([])
              setRootMnemonicOpen(true)
            }}
            rareMeaningIds={rareMeaningIds}
            rareCoreSenseIndexes={rareCoreSenseIndexes}
            rareCoreSenseStale={rareCoreSenseStale}
            hideRareBlocks={hideRareBlocks}
            onCancelRareCoreSense={(coreSenseIndex, label) =>
              setPendingRareCoreCancel({ coreSenseIndex, label })
            }
            onToggleRareCoreSense={(coreSenseIndex, label, marked) => {
              if (!session) return
              if (!marked) {
                setPendingRareCoreCancel({ coreSenseIndex, label })
                return
              }
              const next = [...new Set([...rareCoreSenseIndexes, coreSenseIndex])]
              void setRareCoreSenseIndexes(session.word.wordId, next)
                .then(async () => {
                  setRareCoreSenseIndexesState(await getRareCoreSenseIndexes(session.word.wordId))
                  setRareCoreSenseStale((await listRareCoreSenseViews(session.word.wordId)).stale)
                  showToast('已标记本义不常考')
                })
                .catch(() => showToast('标记本义不常考失败'))
            }}
            onClearStaleRareCoreSenses={() => {
              if (!session) return
              void setRareCoreSenseIndexes(session.word.wordId, rareCoreSenseIndexes)
                .then(async () => {
                  setRareCoreSenseStale(
                    (await listRareCoreSenseViews(session.word.wordId)).stale,
                  )
                  showToast('已清理旧的本义不常考标记')
                })
                .catch(() => showToast('清理旧标记失败'))
            }}
            senseMnemonics={senseMnemonics}
            onOpenSenseMnemonicPanel={() => {
              setSenseEditIndex(null)
              setSensePanelOpen(true)
            }}
            onEditSenseMnemonic={(coreSenseIndex) => {
              const label =
                study.coreSenses[coreSenseIndex - 1]?.label ?? `本义${coreSenseIndex}`
              const text =
                senseMnemonics.find((item) => item.coreSenseIndex === coreSenseIndex)?.text ?? ''
              setSenseEditDialog({ coreSenseIndex, label, text })
            }}
            onAiMarkRare={() => {
              if (!session) return
              void (async () => {
                setRareAiBusy(true)
                setRareAiError(null)
                try {
                  const config = await loadAiConfig()
                  if (!config.apiKey)
                    throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
                  const sources = session.word.meanings.map((meaning, index) => ({
                    index: index + 1,
                    cn: meaning.cn,
                    ...(meaning.pos ? { pos: meaning.pos } : {}),
                  }))
                  const coreSenseSources = study.coreSenses.map((sense, index) => ({
                    index: index + 1,
                    label: sense.label,
                    ...(sense.note ? { note: sense.note } : {}),
                    ...(sense.origin ? { origin: sense.origin } : {}),
                  }))
                  const result = await generateRareMeanings(
                    {
                      word: session.word.headword,
                      meanings: sources,
                      ...(markRareCoreSenses ? { coreSenses: coreSenseSources } : {}),
                    },
                    config,
                    { markCoreSenses: markRareCoreSenses },
                  )
                  const ids = result.rareMeaningIndexes
                    .map((index) => session.word.meanings[index - 1]?.meaningId)
                    .filter((id): id is string => Boolean(id))
                  const coreIndexes = (result.rareCoreSenseIndexes ?? []).filter(
                    (index) => study.coreSenses[index - 1],
                  )
                  if (ids.length === 0 && coreIndexes.length === 0) {
                    showToast(
                      markRareCoreSenses
                        ? '没有需要标记的含义或本义'
                        : '没有需要标记的含义',
                    )
                    return
                  }
                  setRarePreviewItems(
                    session.word.meanings
                      .filter((meaning) => ids.includes(meaning.meaningId))
                      .map((meaning) => ({
                        meaningId: meaning.meaningId,
                        ...(meaning.pos ? { pos: meaning.pos } : {}),
                        cn: meaning.cn,
                      })),
                  )
                  setRarePreviewSelected(ids.filter((id) => !rareMeaningIds.includes(id)))
                  setRareCorePreviewItems(
                    coreIndexes.map((index) => {
                      const sense = study.coreSenses[index - 1]!
                      return {
                        coreSenseIndex: index,
                        label: sense.label,
                        ...(sense.note ? { cn: sense.note } : {}),
                      }
                    }),
                  )
                  setRareCorePreviewSelected(
                    coreIndexes.filter((index) => !rareCoreSenseIndexes.includes(index)),
                  )
                  setRarePreviewOpen(true)
                } catch (error) {
                  const code = (error as { code?: string })?.code
                  setRareAiError(aiErrorMessage(code, 'AI 标记不常考失败'))
                  showToast(aiErrorMessage(code, 'AI 标记不常考失败'))
                } finally {
                  setRareAiBusy(false)
                }
              })()
            }}
            onToggleRareMeaning={(meaningId) => {
              void (async () => {
                const next = rareMeaningIds.includes(meaningId)
                  ? rareMeaningIds.filter((id) => id !== meaningId)
                  : [...rareMeaningIds, meaningId]
                try {
                  const saved = await saveRareMeaningIds(session.word.wordId, next)
                  setRareMeaningIds(saved)
                } catch (error) {
                  showToast(error instanceof Error ? error.message : '保存不常考含义失败')
                }
              })()
            }}
            onHeadwordClick={() => {
              setSubwordLoading(true)
              setSubwords(null)
              void findSubwordMeanings(
                session.word.wordId,
                session.word.deckId,
                20,
              )
                .then((items) => {
                  setSubwords(items)
                })
                .catch(() => setSubwords([]))
                .finally(() => setSubwordLoading(false))
            }}
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
            phrases={session.word.phrases ?? []}
            showPhrases
            speaking={speaking}
            onSpeak={handleSpeak}
            onMarkMeaning={(meaningId) => void actions.markMeaning(meaningId)}
          />
          </div>
        ) : null}

        {stage === 'memory' && session ? (
          <MemoryStage
            headword={session.word.headword}
            derivation={study.memoryDerivation}
            memoryPhase={memoryViewPhase(session)}
            showMeaning={memoryShowMeaning(session)}
            summaryEntries={memorySummaryEntries(session)}
            examples={study.activeCoreSense ? [] : study.memoryExamples}
          coreSenseMnemonic={study.coreSenseContent?.mnemonic ?? null}
          rootEtymology={
            appSettings?.['study.showRootEtymology'] !== false
              ? ((rootEtymology as never) ?? null)
              : null
          }
          hasTopControls={study.activeCoreSense != null}
          threeTapRecall={appSettings?.['memory.threeTapRecall'] !== false}
          cardFlashAnimation={(appSettings as Record<string, unknown> | undefined)?.['memory.cardFlashAnimation'] === true}
          coreSenseGloss={study.coreSenseContent?.gloss ?? null}
          coreSenseOverview={coreSenseOverview}
          coreSenseExamples={
            study.activeCoreSense ? (study.coreSenseContent?.examples ?? []) : []
          }
            mnemonics={study.memoryMnemonics}
            familiarity={study.memoryFamiliarity}
            unfamiliarityRank={study.memoryRank}
            rootLabel={derivationContents[session.word.wordId]?.rootLabel}
            currentLine={(() => {
              const map = derivationContents[session.word.wordId]
              if (!map?.lines?.length || !session.activeMeaningId) return undefined
              const index =
                session.word.meanings.findIndex(
                  (meaning) => meaning.meaningId === session.activeMeaningId,
                ) + 1
              return map.lines.find((line) => line.meaningIndexes.includes(index))?.text
            })()}
            isNc={
              session.activeMeaningId != null && ncMeaningIds.includes(session.activeMeaningId)
            }
            userNotes={study.memoryUserNotes}
            userMnemonics={study.memoryUserMnemonics}
            meaningCn={study.activeMeaningCn ?? ''}
            meaningPos={
              study.meanings.find((meaning) => meaning.meaningId === session.activeMeaningId)?.pos
            }
            count={study.memoryCount}
            total={study.memoryTotal}
            phraseLines={
              study.activeCoreSense
                ? (study.coreSenseContent?.phrases ?? []).map((phrase) => ({
                    en: phrase.en,
                    cn: phrase.cn,
                  }))
                : study.memoryPhrases
            }
            showPhrases={
              study.activeCoreSense
                ? (appSettings?.['memory.coreSensePhraseCount'] ?? 2) > 0
                : memoryShowPhrases
            }
            fontScale={fontScale}
            cardSize={cardSize}
            onTap={actions.memoryTap}
          />
        ) : null}
      </div>

      {stage === 'annotation' && session ? (
        <>
          {/* task-186：始终渲染（打开时用 CSS 隐藏），手势中 target 不被卸载，Chrome 才能持续派发 touchmove/touchend */}
          <button
            type="button"
            className={`derivation-handle${derivationPanelOpen ? ' derivation-handle--hidden' : ''}`}
            aria-label="展开生成元引申"
            aria-hidden={derivationPanelOpen}
            tabIndex={derivationPanelOpen ? -1 : 0}
            onClick={() => {
              if (derivationPanelOpen) return
              setDerivationPanelOpen(true)
              setDerivationWidth(DERIVATION_WIDTH_DEFAULT)
            }}
          >
            ‹ 引申
          </button>
          {derivationPanelOpen &&
          !derivationPanelFullscreen &&
          !derivationUsageOpen &&
          !derivationViewerOpen &&
          !generativeOpen &&
          subwords == null &&
          !subwordLoading &&
          !userEditor &&
          !confirmUserDelete ? (
            <div
              className="derivation-resize-handle"
              role="separator"
              aria-label="拖动调整引申页宽度"
              aria-orientation="vertical"
              aria-valuemin={DERIVATION_WIDTH_MIN}
              aria-valuemax={DERIVATION_WIDTH_MAX}
              aria-valuenow={derivationWidth}
              tabIndex={0}
              onPointerDown={(event) => {
                event.preventDefault()
                event.currentTarget.setPointerCapture?.(event.pointerId)
                derivationDragRef.current = {
                  startX: event.clientX,
                  startWidth: derivationWidth,
                  vw: window.innerWidth || 1,
                }
              }}
              onPointerMove={(event) => {
                const drag = derivationDragRef.current
                if (!drag) return
                const next = derivationWidthFromDrag({
                  startWidth: drag.startWidth,
                  dx: event.clientX - drag.startX,
                  viewportWidth: drag.vw,
                })
                // 同一宽度立即写到根节点 CSS 变量，保证左栏/右页同一帧同步
                ;(document.querySelector('.study-page') as HTMLElement | null)?.style.setProperty(
                  '--derivation-panel-width',
                  `${next}%`,
                )
                setDerivationWidth(next)
              }}
              onPointerUp={() => {
                derivationDragRef.current = null
              }}
              onPointerCancel={() => {
                derivationDragRef.current = null
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setDerivationWidth((w) => Math.min(DERIVATION_WIDTH_MAX, w + 2))
                if (event.key === 'ArrowRight') setDerivationWidth((w) => Math.max(DERIVATION_WIDTH_MIN, w - 2))
              }}
            />
          ) : null}
          <DerivationPanel
            open={derivationPanelOpen}
            mode={derivationMode}
            onModeChange={setDerivationMode}
            onUsageOpenChange={setDerivationUsageOpen}
            onViewerOpenChange={setDerivationViewerOpen}
            markdown={readDerivationMarkdown(settings)}
            ncLabels={session.word.meanings
              .filter((meaning) => ncMeaningIds.includes(meaning.meaningId))
              .map((meaning) => meaning.cn)}
            onExportJson={() => {
              void (async () => {
                try {
                  const map = await getDerivationMap(session.word.wordId)
                  if (!map) {
                    showToast('当前词还没有引申图可导出')
                    return
                  }
                  const json = buildDerivationJson(session.word.headword, map)
                  const blob = new Blob([JSON.stringify(json, null, 2)], {
                    type: 'application/json',
                  })
                  const url = URL.createObjectURL(blob)
                  const link = document.createElement('a')
                  link.href = url
                  link.download = `${session.word.headword}-derivation.json`
                  link.click()
                  URL.revokeObjectURL(url)
                  showToast('已导出当前词引申图')
                } catch (error) {
                  showToast(error instanceof Error ? error.message : '导出失败')
                }
              })()
            }}
            onImportJson={(text) => {
              void (async () => {
                const parsed = parseDerivationJson(text)
                if (!parsed.ok) {
                  showToast(`JSON 无效：${parsed.errors[0] ?? '格式错误'}`)
                  return
                }
                try {
                  const saved = await saveDerivationMap(session.word.wordId, {
                    ...(parsed.value.rootLabel ? { rootLabel: parsed.value.rootLabel } : {}),
                    text: parsed.value.text ?? '',
                    mermaid: parsed.value.mermaid ?? '',
                    ...(parsed.value.lines ? { lines: parsed.value.lines } : {}),
                    source: 'manual',
                  })
                  setDerivationContents((prev) => ({
                    ...prev,
                    [session.word.wordId]: {
                      mode: 'text',
                      text: saved.text ?? '',
                      mermaid: saved.mermaid ?? '',
                      ...(saved.rootLabel ? { rootLabel: saved.rootLabel } : {}),
                      ...(saved.lines ? { lines: saved.lines } : {}),
                      source: saved.source ?? 'manual',
                    },
                  }))
                  setDerivationMode('text')
                  showToast('已导入当前词引申图')
                } catch (error) {
                  showToast(error instanceof Error ? error.message : '导入失败')
                }
              })()
            }}
            fullscreen={derivationPanelFullscreen}
            onToggleFullscreen={() => setDerivationPanelFullscreen((value) => !value)}
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
              setDerivationPanelFullscreen(false)
              setDerivationUsageOpen(false)
              setDerivationViewerOpen(false)
              setDerivationAiError(null)
            }}
            saving={derivationSaving}
            aiBusy={derivationAiBusy}
            aiError={derivationAiError}
            onSave={(content) => {
              void (async () => {
                setDerivationSaving(true)
                try {
                  const saved = await saveDerivationMap(session.word.wordId, {
                    ...(content.rootLabel ? { rootLabel: content.rootLabel } : {}),
                    text: content.text,
                    mermaid: content.mermaid,
                    ...(content.lines ? { lines: content.lines } : {}),
                    source: content.source === 'ai' ? 'ai' : 'manual',
                  })
                  setDerivationContents((prev) => ({
                    ...prev,
                    [session.word.wordId]: {
                      mode: content.mode,
                      text: saved.text ?? content.text,
                      mermaid: saved.mermaid ?? content.mermaid,
                      ...(saved.rootLabel ? { rootLabel: saved.rootLabel } : {}),
                      ...(saved.lines?.length ? { lines: saved.lines } : content.lines?.length ? { lines: content.lines } : {}),
                      source: saved.source ?? content.source ?? 'manual',
                    },
                  }))
                  showToast('已保存引申内容')
                } catch (error) {
                  showToast(error instanceof Error ? error.message : '保存引申内容失败')
                } finally {
                  setDerivationSaving(false)
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
                      meanings,
                    },
                    config,
                  )
                  setDerivationContents((prev) => {
                    const current =
                      prev[session.word.wordId] ?? {
                        mode: derivationMode,
                        text: '',
                        mermaid: '',
                      }
                    return {
                      ...prev,
                      [session.word.wordId]: mergeGeneratedDerivation({
                        current: { ...current, mode: derivationMode },
                        generated: result,
                      }),
                    }
                  })
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
          onGenerativeMemory={
            stage === 'annotation'
              ? () => {
                  setDerivationPanelOpen(false)
                  setDerivationPanelFullscreen(false)
                  setDerivationUsageOpen(false)
                  setDerivationViewerOpen(false)
                  setSubwords(null)
                  setGenerativeSaveStatus(null)
                  setGenerativeOpen(true)
                }
              : undefined
          }
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
          hideRating={detailMode || (tempMode && tempRecordMode === 'practice')}
          onPracticeAssess={
            tempMode && tempRecordMode === 'practice' ? (rating) => actions.tempAssess(rating) : undefined
          }
        />
      ) : null}

      {session && rootEtymologyEditOpen ? (
        <RootEtymologyEditDialog
          open={rootEtymologyEditOpen}
          wordId={session.word.wordId}
          headword={session.word.headword}
          onClose={() => setRootEtymologyEditOpen(false)}
          onChanged={() => setRootEtymologyEditOpen(false)}
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

      {session ? (
        <GenerativeMemoryStage
          open={generativeOpen}
          word={session.word.headword}
          rootLabel={derivationContents[session.word.wordId]?.rootLabel}
          text={derivationContents[session.word.wordId]?.text}
          mermaid={derivationContents[session.word.wordId]?.mermaid}
          showMermaid={generativeSettings.showMermaid}
          rootFontScale={generativeSettings.rootFontScale}
          clicksRequired={generativeSettings.clicks}
          threeTapRecall={appSettings?.['memory.threeTapRecall'] !== false}
          cardFlashAnimation={(appSettings as Record<string, unknown> | undefined)?.['memory.cardFlashAnimation'] === true}
          perScreen={generativeSettings.perScreen}
          meanings={generativeMeaningsForStage3(
            study.meanings,
            rareMeaningIds,
            hideRareBlocks,
          ).map((meaning) => ({
            meaningId: meaning.meaningId,
            pos: meaning.pos,
            cn: meaning.cn,
            examples: meaning.examples,
          }))}
          initialNc={ncMeaningIds}
          saveStatus={generativeSaveStatus}
          rootMnemonicText={rootMnemonicText}
          onEditRootMnemonic={() => {
            setRootMnemonicError(null)
            setRootMnemonicSaveStatus(null)
            setRootMnemonicCandidates([])
            setRootMnemonicOpen(true)
          }}
          aiBusy={derivationAiBusy}
          aiError={derivationAiError}
          onClose={() => setGenerativeOpen(false)}
          onSaveNc={(ids) => {
            void (async () => {
              try {
                await saveNcMeaningIds(session.word.wordId, ids)
                setNcMeaningIds(ids)
                showToast('已保存 nc')
              } catch (error) {
                showToast(error instanceof Error ? error.message : '保存 nc 失败')
              }
            })()
          }}
          onSaveMap={() => {
            const content = derivationContents[session.word.wordId]
            if (!content) {
              showToast('还没有引申图可保存')
              return
            }
            setGenerativeSaveStatus('保存中…')
            void (async () => {
              try {
                await saveDerivationMap(session.word.wordId, {
                  ...(content.rootLabel ? { rootLabel: content.rootLabel } : {}),
                  text: content.text,
                  mermaid: content.mermaid,
                  ...(content.lines ? { lines: content.lines } : {}),
                  source: 'ai',
                })
                setGenerativeSaveStatus('已保存引申图')
                showToast('已保存引申图')
              } catch (error) {
                const message = error instanceof Error ? error.message : '保存引申图失败'
                setGenerativeSaveStatus(`保存失败：${message}`)
                showToast(message)
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
                const result = await generateDerivationMap(
                  {
                    word: session.word.headword,
                    meanings: session.word.meanings.map((meaning, index) => ({
                      index: index + 1,
                      cn: meaning.cn,
                      ...(meaning.pos ? { pos: meaning.pos } : {}),
                    })),
                  },
                  config,
                )
                setDerivationContents((prev) => {
                  const current = prev[session.word.wordId] ?? {
                    mode: 'text' as const,
                    text: '',
                    mermaid: '',
                  }
                  return {
                    ...prev,
                    [session.word.wordId]: mergeGeneratedDerivation({
                      current,
                      generated: result,
                    }),
                  }
                })
                showToast('AI 引申图已生成预览')
              } catch (error) {
                const code = (error as { code?: string })?.code
                setDerivationAiError(aiErrorMessage(code, 'AI 生成引申图失败'))
              } finally {
                setDerivationAiBusy(false)
              }
            })()
          }}
        />
      ) : null}

      <SenseMnemonicEditDialog
        open={senseEditDialog != null}
        wordId={session?.word.wordId ?? ''}
        word={session?.word.headword ?? ''}
        coreSenseIndex={senseEditDialog?.coreSenseIndex ?? 1}
        label={senseEditDialog?.label ?? ''}
        initialText={senseEditDialog?.text ?? ''}
        onClose={() => setSenseEditDialog(null)}
        onChanged={() => {
          if (!session) return
          void listSenseMnemonicViews(session.word.wordId)
            .then((views) =>
              setSenseMnemonics(
                views.current
                  .filter((view) => view.mnemonic)
                  .map((view) => ({
                    coreSenseIndex: view.coreSenseIndex,
                    label: view.label,
                    text: view.mnemonic!.text,
                    source: view.mnemonic!.source,
                  })),
              ),
            )
            .catch(() => undefined)
          study.actions.refreshCoreSenseContent()
        }}
      />

      <CoreSenseOverviewEditDialog
        open={overviewEditOpen}
        wordId={session?.word.wordId ?? ''}
        word={session?.word.headword ?? ''}
        initialText={coreSenseOverview ?? ''}
        onClose={() => setOverviewEditOpen(false)}
        onChanged={() => {
          if (!session) return
          void getCoreSenseOverview(session.word.wordId)
            .then((overview) => setCoreSenseOverview(overview?.text ?? null))
            .catch(() => undefined)
          study.actions.refreshCoreSenseContent()
        }}
      />

      <SenseMnemonicPanel
        open={sensePanelOpen}
        wordId={session?.word.wordId ?? ''}
        word={session?.word.headword ?? ''}
        coreSenses={study.coreSenses}
        initialEditIndex={senseEditIndex}
        onClose={() => {
          setSensePanelOpen(false)
          setSenseEditIndex(null)
        }}
        onChanged={() => {
          if (!session) return
          void getCoreSenseOverview(session.word.wordId).then((overview) =>
            setCoreSenseOverview(overview?.text ?? null),
          ).catch(() => undefined)
          void listSenseMnemonicViews(session.word.wordId).then((views) =>
            setSenseMnemonics(
              views.current
                .filter((view) => view.mnemonic)
                .map((view) => ({
                  coreSenseIndex: view.coreSenseIndex,
                  label: view.label,
                  text: view.mnemonic!.text,
                  source: view.mnemonic!.source,
                })),
            ),
          )
        }}
      />

      {pendingRareCoreCancel ? (
      <ConfirmDialog
        title="取消本义不常考标记？"
        body={`将取消本义${pendingRareCoreCancel.coreSenseIndex}「${pendingRareCoreCancel.label}」的不常考标记。`}
        onCancel={() => setPendingRareCoreCancel(null)}
        onConfirm={() => {
          const target = pendingRareCoreCancel
          setPendingRareCoreCancel(null)
          if (!target || !session) return
          const next = rareCoreSenseIndexes.filter((index) => index !== target.coreSenseIndex)
          void setRareCoreSenseIndexes(session.word.wordId, next)
            .then(async () => {
              setRareCoreSenseIndexesState(await getRareCoreSenseIndexes(session.word.wordId))
              setRareCoreSenseStale((await listRareCoreSenseViews(session.word.wordId)).stale)
              showToast('已取消本义不常考标记')
            })
            .catch(() => showToast('取消本义标记失败'))
        }}
      />
      ) : null}

      <CoreSenseAIPanel
        open={coreSenseAiOpen}
        wordId={session?.word.wordId ?? ''}
        word={session?.word.headword ?? ''}
        coreSenseIndex={study.activeCoreSense?.index ?? 1}
        label={study.activeCoreSense?.label ?? ''}
        exampleCount={appSettings?.['memory.coreSenseExampleCount'] ?? 2}
        phraseCount={appSettings?.['memory.coreSensePhraseCount'] ?? 2}
        onClose={() => setCoreSenseAiOpen(false)}
        onChanged={() => {
          setCoreSenseAiOpen(false)
          study.actions.refreshCoreSenseContent()
          showToast('已保存本义 AI 内容')
          if (session) {
            void listSenseMnemonicViews(session.word.wordId)
              .then((views) =>
                setSenseMnemonics(
                  views.current
                    .filter((view) => view.mnemonic)
                    .map((view) => ({
                      coreSenseIndex: view.coreSenseIndex,
                      label: view.label,
                      text: view.mnemonic!.text,
                      source: view.mnemonic!.source,
                    })),
                ),
              )
              .catch(() => undefined)
          }
        }}
      />

      <RareMeaningsPreviewDialog
        open={rarePreviewOpen}
        word={session?.word.headword ?? ''}
        items={rarePreviewItems}
        selected={rarePreviewSelected}
        coreItems={markRareCoreSenses ? rareCorePreviewItems : []}
        coreSelected={markRareCoreSenses ? rareCorePreviewSelected : []}
        onToggleCore={(coreSenseIndex) =>
          setRareCorePreviewSelected((prev) =>
            prev.includes(coreSenseIndex)
              ? prev.filter((index) => index !== coreSenseIndex)
              : [...prev, coreSenseIndex],
          )
        }
        busy={rareAiBusy}
        error={rareAiError}
        onToggle={(meaningId) =>
          setRarePreviewSelected((prev) =>
            prev.includes(meaningId) ? prev.filter((id) => id !== meaningId) : [...prev, meaningId],
          )
        }
        onApply={() => {
          if (!session) return
          void (async () => {
            setRareAiBusy(true)
            setRareAiError(null)
            try {
              const next = [...new Set([...rareMeaningIds, ...rarePreviewSelected])]
              const saved = await saveRareMeaningIds(session.word.wordId, next)
              setRareMeaningIds(saved)
              if (markRareCoreSenses && rareCorePreviewSelected.length > 0) {
                await setRareCoreSenseIndexes(
                  session.word.wordId,
                  [...new Set([...rareCoreSenseIndexes, ...rareCorePreviewSelected])],
                )
                setRareCoreSenseIndexesState(
                  await getRareCoreSenseIndexes(session.word.wordId),
                )
              }
              setRarePreviewOpen(false)
              setRarePreviewSelected([])
              await actions.reloadCurrentWord()
              showToast('已保存不常考标记')
            } catch (error) {
              const message = error instanceof Error ? error.message : '保存不常考标记失败'
              setRareAiError(message)
            } finally {
              setRareAiBusy(false)
            }
          })()
        }}
        onClose={() => setRarePreviewOpen(false)}
      />

      <RootMnemonicDialog
        open={rootMnemonicOpen}
        word={session?.word.headword ?? ''}
        rootLabel={session ? derivationContents[session.word.wordId]?.rootLabel : undefined}
        initialText={rootMnemonicText}
        candidates={rootMnemonicCandidates}
        busy={rootMnemonicBusy}
        error={rootMnemonicError}
        saveStatus={rootMnemonicSaveStatus}
        onClose={() => setRootMnemonicOpen(false)}
        onGenerate={() => {
          if (!session) return
          void (async () => {
            setRootMnemonicBusy(true)
            setRootMnemonicError(null)
            try {
              const config = await loadAiConfig()
              if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
              const content = derivationContents[session.word.wordId]
              const result = await generateRootMnemonic(
                {
                  word: session.word.headword,
                  rootLabel: content?.rootLabel ?? '',
                  ...(extractRootParagraph(content?.text)
                    ? { firstParagraph: extractRootParagraph(content?.text) }
                    : {}),
                },
                config,
              )
              setRootMnemonicCandidates(result.mnemonics)
            } catch (error) {
              const code = (error as { code?: string })?.code
              setRootMnemonicError(aiErrorMessage(code, 'AI 生成映射助记失败'))
            } finally {
              setRootMnemonicBusy(false)
            }
          })()
        }}
        onSave={(text) => {
          if (!session) return
          void (async () => {
            setRootMnemonicBusy(true)
            setRootMnemonicError(null)
            try {
              const saved = await saveRootMnemonic(session.word.wordId, text, 'manual')
              setRootMnemonicText(saved.text)
              setRootMnemonicSaveStatus('已保存映射助记（两处已同步）')
            } catch (error) {
              setRootMnemonicError(error instanceof Error ? error.message : '保存映射助记失败')
            } finally {
              setRootMnemonicBusy(false)
            }
          })()
        }}
      />

      <SubwordDialog
        open={subwords != null || subwordLoading}
        headword={session?.word.headword ?? ''}
        loading={subwordLoading}
        items={subwords ?? []}
        onClose={() => {
          setSubwords(null)
          setSubwordLoading(false)
        }}
      />

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
