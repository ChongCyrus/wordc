/**
 * 学习会话 hook（task-9 局部 hook，不依赖 src/app/hooks）。
 *
 * 职责：把 core 的状态机与 data 的持久化接起来给 UI 用：
 *   队列加载 → 逐词 createSession → 白板/注释/记忆三态推进
 *   → 不熟悉度 encounters/clicks 写入（D40 / SPEC §4.6）
 *   → w-c 中断快照持久化（D15 / SPEC §4.7）
 *   → 评分提交（submitRating）→ 队列回炉（SPEC §4.8）→ 下一词 / 完成
 *
 * UI 只消费本 hook 暴露的 ViewModel 与动作；算法/存储逻辑都在 core/data。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { MutableRefObject } from 'react'
import {
  advanceMemory,
  countsFromSnapshot,
  createSession,
  createWordState,
  exitMemory,
  isFirstShow,
  familiarity,
  markMeaning,
  normalizeMeaningStat,
  normalizeSessionSettings,
  openMemory,
  predictAll,
  sessionSnapshot,
  shouldRecordEncounters,
  tapBoard,
  tapMemory,
  type MeaningStat,
  type Rating,
  type SessionSettings,
  type SessionState,
  type SettingsMap,
  type Word,
  type WordPredicts,
  type WordState,
} from '../../../core'
import {
  deleteSessionSnapshot,
  ensureBuiltinDecks,
  getLastRatingRecord,
  getSettings,
  getState,
  getTodayPlan,
  getWord,
  listDecks,
  loadSessionSnapshot,
  rateInPlan,
  recordMeaningClick,
  recordMeaningEncounters,
  reRateInPlan,
  saveSessionSnapshot,
  getEffectiveContent,
  updateSettings,
  type AppSettings,
  type DailyPlan,
} from '../../../data'
import type { DerivationChainView } from '../components/DerivationChain'
import type {
  ExampleView,
  MeaningView,
  MnemonicView,
  PhraseView,
} from '../components/types'
import { buildOfficialHints, type NextHints } from '../lib/next-hint'
import { phrasesForMeaning } from '../lib/memory-phrases'
import { submitRatingByMode } from '../lib/rate-action'
import { ratingLabels as labelsOf, type RatingLabels } from '../lib/rating-labels'
import { readOfficialBool } from '../../../app/hooks/officialSettings'

/** getEffectiveContent 的语义部分（task-75/77；缺字段时安全回退） */
interface EffectiveSemantics {
  coreSenses?: Array<{ label?: string; source?: string }>
  meaningMap?: Array<{
    meaningIndex: number
    coreSenseIndex?: number
    note?: string
    source?: string
    steps?: string[]
  }>
}

/** 由 coreSenses/meaningMap 构造「本义→引申」链；无映射返回 undefined（隐藏） */
function derivationFor(
  effective: EffectiveSemantics | null | undefined,
  meaningIndex: number,
): DerivationChainView | undefined {
  const mapping = effective?.meaningMap?.find((item) => item.meaningIndex === meaningIndex)
  if (!mapping) return undefined
  const core = effective?.coreSenses?.[(mapping.coreSenseIndex ?? 0) - 1]
  const steps = mapping.steps?.length
    ? mapping.steps
    : [core?.label, mapping.note].filter(
        (step): step is string => typeof step === 'string' && step.trim().length > 0,
      )
  if (steps.length === 0) return undefined
  return { steps, aiGenerated: core?.source === 'ai' || mapping.source === 'ai' }
}

export type StudyPhase = 'loading' | 'error' | 'studying' | 'done' | 'empty' | 'no-deck'

export interface StudyProgress {
  /** 当前第几个词（1 起） */
  index: number
  total: number
  /** 已完成比例 0–1（用于顶部 2px 进度条） */
  fraction: number
}

export interface StudyMemoryProgress {
  /** 已完成含义数 */
  completed: number
  /** 含义总数 */
  total: number
  fraction: number
}

export interface StudyViewModel {
  phase: StudyPhase
  errorMessage: string | null
  /** 当前词会话（阶段/次数/设置） */
  session: SessionState | null
  stage: 'board' | 'annotation' | 'memory'
  settings: AppSettings | null
  word: Word | null
  meanings: MeaningView[]
  examples: ExampleView[]
  mnemonics: MnemonicView[]
  /** w-c 页显示的词组（含当前 w/c，最多 3 条） */
  memoryPhrases: PhraseView[]
  /** w-c 当前 c 的本义→引申链（task-77；无映射 undefined） */
  memoryDerivation?: DerivationChainView
  progress: StudyProgress
  memoryProgress: StudyMemoryProgress
  memoryCount: number
  memoryTotal: number
  activeMeaningCn: string | null
  /** 三个评分按钮的「下次出现」副标题（core.predictAll 官方 Predict 格式化） */
  nextHints: NextHints | undefined
  /** 三个评分按钮主标签（官方按 is_first_show 切换，可配置） */
  ratingLabels: RatingLabels
  /** 本次会话实际提交过评分的词数（去重） */
  learnedCount: number
  minutes: number
  submitting: boolean
  /** 是否可回退到上一词（首词/记忆页禁用） */
  canGoBack: boolean
  /** 当前是否处于「回退浏览上一词」状态（未改判） */
  browseBack: boolean
  /** 回退浏览时该词上一次的评分（显示「上次选择：X」） */
  lastChoice: Rating | null
}

export interface StudyActions {
  reload: () => Promise<void>
  rate: (rating: Rating) => Promise<void>
  boardTap: () => Promise<void>
  markMeaning: (meaningId: string) => Promise<void>
  openMemory: () => void
  memoryTap: () => void
  exitMemory: () => void
  updateStudySettings: (patch: Partial<SettingsMap>) => Promise<void>
  /** 退出学习前调用：立即保存当前记忆进度快照（D15） */
  flushSnapshot: () => Promise<void>
  /** 返回上一词（只浏览，不撤销；点评分才改判） */
  goBack: () => Promise<void>
  /** 回退浏览后不修改，继续当前进度 */
  continueForward: () => Promise<void>
  /** 每日学习量变更后刷新 plan（保留当前词，不清空 w-c/注释面状态） */
  refreshPlan: () => Promise<void>
  /** 重新从 DB 读取当前词（AI 落库后刷新注释面/w-c 内容） */
  reloadCurrentWord: () => Promise<void>
}

export function useStudySession(options?: {
  onToast?: (message: string) => void
}): StudyViewModel & { actions: StudyActions } {
  const onToast = options?.onToast
  const onToastRef = useRef(onToast)
  useEffect(() => {
    onToastRef.current = onToast
  }, [onToast])
  const [phase, setPhase] = useState<StudyPhase>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [session, setSessionState] = useState<SessionState | null>(null)
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [word, setWord] = useState<Word | null>(null)
  const [meaningStats, setMeaningStats] = useState<Record<string, MeaningStat>>({})
  /** 当前词的完整 WordState（供 core.previewNext 预览三键下一次出现时间） */
  const [wordState, setWordState] = useState<WordState | null>(null)
  const [plan, setPlanState] = useState<DailyPlan | null>(null)
  const [viewIndex, setViewIndex] = useState(0)
  const [browseIndex, setBrowseIndex] = useState<number | null>(null)
  const [lastChoice, setLastChoice] = useState<Rating | null>(null)
  const [learnedCount, setLearnedCount] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  const sessionRef = useRef<SessionState | null>(null)
  const planRef = useRef<DailyPlan | null>(null)
  const viewIndexRef = useRef(0)
  const browseRef = useRef<number | null>(null)
  const lastChoiceRef = useRef<Rating | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const learnedRef = useRef<Set<string>>(new Set())
  const studyStartedAtRef = useRef<number>(Date.now())
  const snapshotTimerRef = useRef<number | null>(null)
  const advanceTimerRef = useRef<number | null>(null)
  const submittingRef = useRef(false)
  const mountedRef = useRef(true)

  const toast = useCallback((message: string) => {
    onToastRef.current?.(message)
  }, [])

  const applySession = useCallback((next: SessionState | null) => {
    sessionRef.current = next
    setSessionState(next)
  }, [])

  const applyPlan = useCallback((next: DailyPlan | null) => {
    planRef.current = next
    setPlanState(next)
  }, [])

  const applyViewIndex = useCallback((index: number) => {
    viewIndexRef.current = index
    setViewIndex(index)
  }, [])

  const applyBrowse = useCallback((index: number | null) => {
    browseRef.current = index
    setBrowseIndex(index)
  }, [])

  const applyLastChoice = useCallback((rating: Rating | null) => {
    lastChoiceRef.current = rating
    setLastChoice(rating)
  }, [])

  const clearTimer = useCallback((ref: MutableRefObject<number | null>) => {
    if (ref.current != null) {
      window.clearTimeout(ref.current)
      ref.current = null
    }
  }, [])

  /** 即时保存当前会话快照（D15） */
  const saveSnapshotNow = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    clearTimer(snapshotTimerRef)
    try {
      await saveSessionSnapshot(sessionSnapshot(current))
    } catch (error) {
      toast(`保存记忆进度失败：${errorMessageOf(error)}`)
    }
  }, [clearTimer, toast])

  /** 记忆页每次 +1 后 debounce 500ms 保存（SPEC §4.7） */
  const scheduleSnapshot = useCallback(() => {
    clearTimer(snapshotTimerRef)
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null
      const current = sessionRef.current
      if (!current) return
      void saveSessionSnapshot(sessionSnapshot(current)).catch((error: unknown) => {
        toast(`保存记忆进度失败：${errorMessageOf(error)}`)
      })
    }, 500)
  }, [clearTimer, toast])

  const mergeStats = useCallback(
    (next: Record<string, MeaningStat> | undefined) => {
      if (!next) return
      setMeaningStats((prev) => {
        const merged: Record<string, MeaningStat> = { ...prev }
        for (const [key, stat] of Object.entries(next)) {
          const old = normalizeMeaningStat(prev[key])
          const incoming = normalizeMeaningStat(stat)
          merged[key] = {
            clicks: Math.max(old.clicks, incoming.clicks),
            encounters: Math.max(old.encounters, incoming.encounters),
          }
        }
        return merged
      })
    },
    [],
  )

  const toSessionSettings = useCallback((s: AppSettings): SessionSettings => {
    return {
      totalRepeats: s['memory.totalRepeats'],
      mode: s['memory.mode'],
      showPhrases: s['memory.showPhrases'],
      exampleCount: s['board.exampleCount'],
      showPhonetic: s['board.showPhonetic'],
    }
  }, [])

  /** 把 data 的 Word 映射成 core 的 SessionWord（展示字段按设置挑选） */
  const toSessionWord = useCallback(
    (source: Word, showPhonetic: boolean) => {
      const phoneticText = showPhonetic
        ? (source.phonetic?.us ?? source.phonetic?.uk ?? '').trim()
        : ''
      return {
        wordId: source.id,
        deckId: source.deckId,
        headword: source.headword,
        phonetic: phoneticText || undefined,
        meanings: source.meanings.map((meaning) => ({
          meaningId: meaning.id,
          pos: meaning.pos,
          cn: meaning.cn,
        })),
        phrases: source.phrases.map((phrase) => ({ en: phrase.en, cn: phrase.cn })),
      }
    },
    [],
  )

  /** 从 plan 的 index 起加载第一个存在的词；跳到末尾时进入完成状态 */
  const loadWordAt = useCallback(
    async (
      index: number,
      targetPlan: DailyPlan,
      s: AppSettings,
      opts?: { startAt?: 'board' | 'annotation' },
    ): Promise<boolean> => {
      const wordIds = targetPlan.wordIds
      let cursor = index
      while (cursor >= 0 && cursor < wordIds.length) {
        const wordId = wordIds[cursor]
        if (wordId == null) break
        let loadedWord: Word | null
        try {
          loadedWord = await getWord(wordId)
        } catch (error) {
          toast(`加载单词失败：${errorMessageOf(error)}`)
          loadedWord = null
        }
        if (!loadedWord) {
          cursor += 1
          continue
        }
        let state: WordState | null
        try {
          state = await getState(wordId)
        } catch {
          state = null
        }
        let savedCounts: Record<string, number> = {}
        try {
          const snapshot = await loadSessionSnapshot(wordId)
          savedCounts = countsFromSnapshot(snapshot)
        } catch {
          savedCounts = {}
        }
        let next = createSession({
          word: toSessionWord(loadedWord, s['board.showPhonetic']),
          settings: toSessionSettings(s),
          savedCounts,
        })
        // 回退浏览：直接打开注释面（不重复记 encounters）
        if (opts?.startAt === 'annotation') {
          next = tapBoard(next)
        }
        applySession(next)
        setWord(loadedWord)
        setMeaningStats(state?.meaningStats ?? {})
        setWordState(
          state ?? createWordState({ wordId, deckId: loadedWord.deckId, now: Date.now() }),
        )
        applyViewIndex(cursor)
        return true
      }
      setWord(null)
      applySession(null)
      setPhase(learnedRef.current.size > 0 ? 'done' : 'empty')
      return false
    },
    [applySession, applyViewIndex, toSessionSettings, toSessionWord, toast],
  )

  const load = useCallback(async () => {
    setPhase('loading')
    setErrorMessage(null)
    try {
      await ensureBuiltinDecks()
      const [loadedSettings, decks] = await Promise.all([getSettings(), listDecks()])
      if (!mountedRef.current) return
      setSettingsState(loadedSettings)
      settingsRef.current = loadedSettings
      if (decks.length === 0) {
        setPhase('no-deck')
        return
      }
      const selected = loadedSettings['data.selectedDeckId']
      const deckExists = decks.some((deck) => deck.id === selected)
      const deckId = deckExists ? selected : (decks.find((deck) => deck.isDefault)?.id ?? decks[0]?.id ?? null)
      if (!deckId) {
        setPhase('no-deck')
        return
      }
      // plan 驱动：当天已有未完成 plan → 直接续学（不重排）
      const todayPlan = await getTodayPlan({
        deckId,
        dailyGoal: loadedSettings['study.dailyGoal'],
      })
      if (!mountedRef.current) return
      applyPlan(todayPlan)
      applyBrowse(null)
      applyLastChoice(null)
      if (todayPlan.wordIds.length === 0) {
        setPhase('empty')
        return
      }
      learnedRef.current = new Set(
        todayPlan.ratings.filter((rating) => rating.corrected !== true).map((rating) => rating.wordId),
      )
      setLearnedCount(learnedRef.current.size)
      studyStartedAtRef.current = Date.now()
      const ok = await loadWordAt(todayPlan.index, todayPlan, loadedSettings)
      if (!mountedRef.current) return
      if (ok) {
        setPhase('studying')
      }
    } catch (error) {
      if (!mountedRef.current) return
      setErrorMessage(errorMessageOf(error))
      setPhase('error')
    }
  }, [applyBrowse, applyLastChoice, applyPlan, loadWordAt])

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      clearTimer(snapshotTimerRef)
      clearTimer(advanceTimerRef)
      // 离开页面：记忆中的进度立即落盘（D15）
      const current = sessionRef.current
      if (current && current.stage === 'memory') {
        void saveSessionSnapshot(sessionSnapshot(current)).catch(() => undefined)
      }
    }
  }, [clearTimer, load])

  /* ---------------- 白板面 ---------------- */

  const boardTap = useCallback(async () => {
    const current = sessionRef.current
    if (!current || current.stage !== 'board') return
    const record = shouldRecordEncounters(current)
    const next = tapBoard(current)
    applySession(next)
    if (!record) return
    const meaningIds = next.word.meanings.map((meaning) => meaning.meaningId)
    // 乐观 +1 encounters，随后用 data 返回值校正
    setMeaningStats((prev) => {
      const optimistic: Record<string, MeaningStat> = { ...prev }
      for (const id of meaningIds) {
        const stat = normalizeMeaningStat(prev[id])
        optimistic[id] = { clicks: stat.clicks, encounters: stat.encounters + 1 }
      }
      return optimistic
    })
    try {
      const updated = await recordMeaningEncounters(next.word.wordId, meaningIds)
      if (!mountedRef.current) return
      mergeStats(updated.meaningStats)
      setWordState(updated)
    } catch (error) {
      toast(`记录「遇到」次数失败：${errorMessageOf(error)}`)
    }
  }, [applySession, mergeStats, toast])

  /* ---------------- 含义点击（标记不熟） ---------------- */

  const handleMarkMeaning = useCallback(
    async (meaningId: string) => {
      const current = sessionRef.current
      if (!current) return
      applySession(markMeaning(current, meaningId))
      setMeaningStats((prev) => {
        const stat = normalizeMeaningStat(prev[meaningId])
        return { ...prev, [meaningId]: { clicks: stat.clicks + 1, encounters: stat.encounters } }
      })
      try {
        const updated = await recordMeaningClick(current.word.wordId, meaningId)
        if (!mountedRef.current) return
        mergeStats(updated.meaningStats)
        setWordState(updated)
      } catch (error) {
        toast(`保存不熟悉度失败：${errorMessageOf(error)}`)
      }
    },
    [applySession, mergeStats, toast],
  )

  /* ---------------- 记忆 w-c ---------------- */

  /**
   * 点「记忆」：进入未满的 c；若全部含义已记满，core.openMemory 会自动重置 wcCounts
   * 并重开一轮（记忆可反复进行）。按钮永不锁死，也不再用 wcCompletedOnce 拦截。
   */
  const handleOpenMemory = useCallback(() => {
    const current = sessionRef.current
    if (!current || current.stage !== 'annotation') return
    const next = openMemory(current)
    if (next.stage !== 'memory') return // 无含义脏数据兜底：留在注释面
    applySession(next)
    scheduleSnapshot()
  }, [applySession, scheduleSnapshot])

  const handleMemoryTap = useCallback(() => {
    const current = sessionRef.current
    if (!current || current.stage !== 'memory') return
    const tapped = tapMemory(current)
    applySession(tapped)
    scheduleSnapshot()

    // random 模式（task-22）：tapMemory 已直接切到下一个未满 c（needsAdvance 恒 false）；
    // 全部满时直接返回 annotation，不经过 advanceMemory —— 这里补「记忆完成」提示。
    if (tapped.stage === 'annotation') {
      clearTimer(advanceTimerRef)
      clearTimer(snapshotTimerRef)
      void saveSessionSnapshot(sessionSnapshot(tapped)).catch(() => undefined)
      toast('记忆完成，可再次点击继续')
      return
    }

    if (!tapped.needsAdvance) return
    // 满次数：等 200ms 数字/点阵动画后切下一个 c（SPEC §5.3）
    clearTimer(advanceTimerRef)
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null
      const latest = sessionRef.current
      if (!latest || !latest.needsAdvance) return
      const advanced = advanceMemory(latest)
      applySession(advanced)
      if (advanced.stage === 'annotation') {
        clearTimer(snapshotTimerRef)
        void saveSessionSnapshot(sessionSnapshot(advanced)).catch(() => undefined)
        toast('记忆完成，可再次点击继续')
      } else {
        scheduleSnapshot()
      }
    }, 220)
  }, [applySession, clearTimer, scheduleSnapshot, toast])

  const handleExitMemory = useCallback(() => {
    const current = sessionRef.current
    if (!current || current.stage !== 'memory') return
    clearTimer(advanceTimerRef)
    const next = exitMemory(current)
    applySession(next)
    void saveSnapshotNow()
  }, [applySession, clearTimer, saveSnapshotNow])

  /* ---------------- 评分提交 ---------------- */

  const RATING_LABEL: Record<Rating, string> = {
    familiar: '认识',
    vague: '模糊',
    forgot: '忘记',
  }

  const handleRate = useCallback(
    async (rating: Rating) => {
      const current = sessionRef.current
      const loadedSettings = settingsRef.current
      if (!current || submittingRef.current || !loadedSettings) return
      submittingRef.current = true
      setSubmitting(true)
      const wordId = current.word.wordId
      const planBefore = planRef.current
      const browsing = browseRef.current != null
      const previousChoice = lastChoiceRef.current
      try {
        // 回退浏览 → reRateInPlan（改判）；正常 → rateInPlan（task-44 抽出可 mock 的分支）
        const outcome = await submitRatingByMode<{
          plan: DailyPlan | null
          reverted: boolean
        }>(
          { wordId, rating, planId: planBefore?.id, browseBack: browsing },
          {
            rate: async (args) => {
              const result = await rateInPlan(args)
              return { plan: result.plan ?? planBefore, reverted: false }
            },
            reRate: async (args) => {
              const result = await reRateInPlan(args)
              return result
                ? { plan: result.plan, reverted: true }
                : { plan: null, reverted: false }
            },
          },
        )
        if (browsing && !outcome.reverted) {
          toast('这条反馈已无法撤销，无法改判')
          return
        }
        const planAfter: DailyPlan | null = outcome.plan
        if (browsing) {
          const before = previousChoice ? RATING_LABEL[previousChoice] : '上一次'
          toast(`已将「${before}」改为「${RATING_LABEL[rating]}」，计划已更新`)
        }
        if (!mountedRef.current) return
        learnedRef.current.add(wordId)
        setLearnedCount(learnedRef.current.size)
        try {
          await deleteSessionSnapshot(wordId)
        } catch {
          /* 快照删除失败不阻塞学习 */
        }

        applyBrowse(null)
        applyLastChoice(null)
        applyPlan(planAfter)

        if (
          !planAfter ||
          planAfter.completedAt != null ||
          planAfter.index >= planAfter.wordIds.length
        ) {
          applySession(null)
          setWord(null)
          setPhase(learnedRef.current.size > 0 ? 'done' : 'empty')
          return
        }
        await loadWordAt(planAfter.index, planAfter, loadedSettings)
      } catch (error) {
        toast(`提交失败，请重试：${errorMessageOf(error)}`)
      } finally {
        submittingRef.current = false
        if (mountedRef.current) setSubmitting(false)
      }
    },
    [applyBrowse, applyLastChoice, applyPlan, applySession, loadWordAt, toast],
  )

  /* ---------------- 回退上一词 / 继续 ---------------- */

  const handleGoBack = useCallback(async () => {
    const currentPlan = planRef.current
    const loadedSettings = settingsRef.current
    if (!currentPlan || !loadedSettings || submittingRef.current) return
    const from = browseRef.current ?? viewIndexRef.current
    const targetIndex = from - 1
    if (targetIndex < 0) return
    const wordId = currentPlan.wordIds[targetIndex]
    if (!wordId) return
    try {
      // 只浏览不撤销；点三键时才走 reRateInPlan
      const snapshot = await getLastRatingRecord(wordId)
      if (!snapshot) {
        toast('更早的反馈不可修改')
        return
      }
      applyBrowse(targetIndex)
      applyLastChoice(snapshot.log.rating)
      const ok = await loadWordAt(targetIndex, currentPlan, loadedSettings, {
        startAt: 'annotation',
      })
      if (!ok) {
        applyBrowse(null)
        applyLastChoice(null)
      }
    } catch (error) {
      toast(`回退失败：${errorMessageOf(error)}`)
    }
  }, [applyBrowse, applyLastChoice, loadWordAt, toast])

  const handleContinueForward = useCallback(async () => {
    const currentPlan = planRef.current
    const loadedSettings = settingsRef.current
    if (!currentPlan || !loadedSettings) return
    applyBrowse(null)
    applyLastChoice(null)
    if (currentPlan.index >= currentPlan.wordIds.length) {
      setPhase(learnedRef.current.size > 0 ? 'done' : 'empty')
      return
    }
    await loadWordAt(currentPlan.index, currentPlan, loadedSettings)
  }, [applyBrowse, applyLastChoice, loadWordAt])

  /* ---------------- 设置实时生效 ---------------- */

  const handleUpdateStudySettings = useCallback(
    async (patch: Partial<SettingsMap>) => {
      const updated = await updateSettings(patch)
      if (!mountedRef.current) return
      setSettingsState(updated)
      settingsRef.current = updated
      const current = sessionRef.current
      if (current) {
        applySession({ ...current, settings: normalizeSessionSettings(toSessionSettings(updated)) })
      }
      // 音标开关变化时，重新挑选当前词的音标展示文本
      const currentWord = word
      if (currentWord && 'board.showPhonetic' in patch) {
        const nextSession = sessionRef.current
        if (nextSession) {
          applySession({
            ...nextSession,
            word: {
              ...nextSession.word,
              phonetic:
                (updated['board.showPhonetic']
                  ? (currentWord.phonetic?.us ?? currentWord.phonetic?.uk ?? '')
                  : ''
                ).trim() || undefined,
            },
          })
        }
      }
    },
    [applySession, toSessionSettings, word],
  )

  const handleFlushSnapshot = useCallback(async () => {
    await saveSnapshotNow()
  }, [saveSnapshotNow])

  /**
   * 每日学习量重算后刷新 plan（task-35）：只更新 plan/viewIndex/settings，
   * **不动当前 session**（w-c 次数/注释面状态保留，当前词不被删除）。
   */
  const handleReloadCurrentWord = useCallback(async () => {
    const current = sessionRef.current
    const plan = planRef.current
    const loadedSettings = settingsRef.current
    if (!current || !plan || !loadedSettings) return
    await loadWordAt(viewIndexRef.current, plan, loadedSettings, { startAt: 'annotation' })
  }, [loadWordAt])

  const handleRefreshPlan = useCallback(async () => {
    const currentPlan = planRef.current
    if (!currentPlan) {
      // 无 plan 时也刷新设置（学习页快捷设置显示新值）
      const settingsNow = await getSettings()
      if (!mountedRef.current) return
      setSettingsState(settingsNow)
      settingsRef.current = settingsNow
      return
    }
    const updated = await getTodayPlan({ deckId: currentPlan.deckId })
    if (!mountedRef.current) return
    const currentWordId = sessionRef.current?.word.wordId
    applyPlan(updated)
    if (currentWordId) {
      const from = Math.max(0, (browseRef.current ?? viewIndexRef.current) - 1)
      const found = updated.wordIds.indexOf(currentWordId, from)
      const target =
        found >= 0
          ? found
          : Math.min(updated.index, Math.max(0, updated.wordIds.length - 1))
      applyViewIndex(target)
    } else {
      applyViewIndex(updated.index)
    }
    const settingsNow = await getSettings()
    if (!mountedRef.current) return
    setSettingsState(settingsNow)
    settingsRef.current = settingsNow
  }, [applyPlan, applyViewIndex])

  /* ---------------- 派生 ViewModel ---------------- */

  // task-77：当前词的本义/引申语义（pack 应用后 Dexie 变更自动刷新）
  const effectiveSemantics = useLiveQuery<EffectiveSemantics | null>(
    () => {
      const wordId = session?.word.wordId
      return wordId ? (getEffectiveContent(wordId) as Promise<EffectiveSemantics | null>) : Promise.resolve(null)
    },
    [session?.word.wordId],
  )

  const meanings = useMemo<MeaningView[]>(() => {
    if (!session) return []
    return session.word.meanings.map((meaning, index) => {
      const stat = normalizeMeaningStat(meaningStats[meaning.meaningId])
      return {
        meaningId: meaning.meaningId,
        pos: meaning.pos,
        cn: meaning.cn,
        clicks: stat.clicks,
        encounters: stat.encounters,
        familiarity: familiarity(stat.clicks, stat.encounters),
        derivation: derivationFor(effectiveSemantics, index + 1),
      }
    })
  }, [effectiveSemantics, meaningStats, session])

  const examples = useMemo<ExampleView[]>(() => {
    if (!word) return []
    return word.examples.map((example) => ({ en: example.en, cn: example.cn }))
  }, [word])

  const mnemonics = useMemo<MnemonicView[]>(() => {
    if (!word) return []
    return word.mnemonics.map((mnemonic) => ({ type: mnemonic.type, text: mnemonic.text }))
  }, [word])

  const activeMeaning = useMemo(() => {
    if (!session || !session.activeMeaningId) return null
    return (
      session.word.meanings.find((meaning) => meaning.meaningId === session.activeMeaningId) ?? null
    )
  }, [session])

  // task-43：w-c 只显示当前 c 的词组（meaningId 匹配）；null/缺失不硬猜、直接隐藏
  const memoryDerivation = useMemo<DerivationChainView | undefined>(() => {
    if (!session?.activeMeaningId) return undefined
    const index = session.word.meanings.findIndex(
      (meaning) => meaning.meaningId === session.activeMeaningId,
    )
    return derivationFor(effectiveSemantics, index + 1)
  }, [effectiveSemantics, session])

  const memoryPhrases = useMemo<PhraseView[]>(() => {
    if (!session || !word) return []
    return phrasesForMeaning(word.phrases, activeMeaning?.meaningId, 3)
  }, [activeMeaning, session, word])

  const planWordIds = plan?.wordIds ?? []
  const total = planWordIds.length
  const progress: StudyProgress = {
    index: total === 0 ? 0 : Math.min(viewIndex + 1, total),
    total,
    fraction: total === 0 ? 0 : Math.min(1, viewIndex / total),
  }
  const canGoBack =
    phase === 'studying' &&
    plan != null &&
    (browseIndex ?? viewIndex) > 0 &&
    (session?.stage ?? 'board') !== 'memory'

  const memoryProgress = useMemo<StudyMemoryProgress>(() => {
    if (!session) return { completed: 0, total: 0, fraction: 0 }
    const meaningTotal = session.word.meanings.length
    const repeatTotal = session.settings.totalRepeats
    const completed = session.word.meanings.filter(
      (meaning) => (session.wcCounts[meaning.meaningId] ?? 0) >= repeatTotal,
    ).length
    return {
      completed,
      total: meaningTotal,
      fraction: meaningTotal === 0 ? 0 : completed / meaningTotal,
    }
  }, [session])

  const ratingLabels = useMemo<RatingLabels>(() => {
    const labelSwitch = readOfficialBool(settings, 'study.labelSwitch')
    return labelsOf({ isFirstShow: wordState ? isFirstShow(wordState) : true, labelSwitch })
  }, [settings, wordState])

  /** 三键预测（官方 Predict{first,days,progress}，core.predictAll 一次算三支） */
  const predicts = useMemo<WordPredicts | null>(() => {
    if (!wordState) return null
    return predictAll(wordState, Date.now())
  }, [wordState])

  const showPredictedInterval = readOfficialBool(settings, 'memory.showPredictedInterval')

  const nextHints = useMemo<NextHints | undefined>(() => {
    if (!predicts) return undefined
    return buildOfficialHints(predicts, showPredictedInterval)
  }, [predicts, showPredictedInterval])

  const memoryCount =
    session && activeMeaning ? (session.wcCounts[activeMeaning.meaningId] ?? 0) : 0
  const memoryTotal = session ? session.settings.totalRepeats : 3
  const minutes = Math.max(1, Math.round((Date.now() - studyStartedAtRef.current) / 60_000))

  return {
    phase,
    errorMessage,
    session,
    stage: session?.stage ?? 'board',
    settings,
    word,
    meanings,
    examples,
    mnemonics,
    memoryPhrases,
    memoryDerivation,
    nextHints,
    ratingLabels,
    progress,
    memoryProgress,
    memoryCount,
    memoryTotal,
    activeMeaningCn: activeMeaning?.cn ?? null,
    learnedCount,
    minutes,
    submitting,
    canGoBack,
    browseBack: browseIndex != null,
    lastChoice,
    actions: {
      reload: load,
      rate: handleRate,
      boardTap,
      markMeaning: handleMarkMeaning,
      openMemory: handleOpenMemory,
      memoryTap: handleMemoryTap,
      exitMemory: handleExitMemory,
      updateStudySettings: handleUpdateStudySettings,
      flushSnapshot: handleFlushSnapshot,
      goBack: handleGoBack,
      continueForward: handleContinueForward,
      refreshPlan: handleRefreshPlan,
    reloadCurrentWord: handleReloadCurrentWord,
    },
  }
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}
