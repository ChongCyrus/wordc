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
import {
  CORE_SENSE_MEANING_PREFIX,
  buildCoreSenseWeightedUnits,
  toCoreSenseSessionWord,
} from '../../../core'
import type { MutableRefObject } from 'react'
import {
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
  sessionMeaningIdOf,
  sessionSnapshot,
  shouldRecordEncounters,
  tapBoard,
  tapMemory,
  weightedMemoryTotals,
  weightedSettingsFromSettings,
  memoryTotalForMeaning,
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
  getWordDetailBundle,
  listDecks,
  loadSessionSnapshot,
  rateInPlan,
  updateSettings,
  recordMeaningClick,
  startTempReview,
  rateTempReview,
  captureTempReviewSnapshot,
  summarizeTempReview,
  advanceTempReviewBatch,
  summarizePracticeReview,
  applyTempReviewToDhp,
  type TempReviewSession,
  type TempReviewRecordInput,
  type TempReviewSummary,
  type TempReviewFamiliaritySnapshot,
  recordMeaningEncounters,
  getCoreSenseStats,
  getEffectiveContent,
  recordCoreSenseClick,
  recordCoreSenseEncounters,
  listCoreSenseExampleViews,
  listCoreSensePhraseViews,
  listCoreSenseRepresentatives,
  listSenseMnemonics,
  reRateInPlan,
  saveSessionSnapshot,
  type AppSettings,
  type DailyPlan,
} from '../../../data'
import { coreSenseDisplayContent, pickCoreSenseEntry } from '../lib/core-sense-display'
import type { DerivationChainView } from '../components/DerivationChain'
import type { UserMnemonicView, UserNoteView } from '../components/types'
import type {
  ExampleView,
  MeaningView,
  MnemonicView,
  PhraseView,
} from '../components/types'
import { buildOfficialHints, type NextHints } from '../lib/next-hint'
import { phrasesForMeaning } from '../lib/memory-phrases'
import { meaningsForMemory } from '../lib/study-meanings'
import { visibleMnemonics } from '../lib/user-mnemonics'
import { submitRatingByMode } from '../lib/rate-action'
import { flushProgressCheckpoint, scheduleProgressCheckpoint } from '../../../app/utils/auto-backup-service'
import { ratingLabels as labelsOf, type RatingLabels } from '../lib/rating-labels'
import { readOfficialBool } from '../../../app/hooks/officialSettings'
import {
  deleteAiMnemonic,
  deleteUserMnemonic,
  deleteUserNote,
  hideMnemonic as _hideMnemonic,
  upsertUserMnemonic,
  upsertUserNote,
  type UserMnemonicInput,
  type UserNoteInput,
} from '../../../data'

/** getEffectiveContent 的语义部分（task-75/77；缺字段时安全回退） */
interface EffectiveSemantics {
  coreSenses?: Array<{ label?: string; note?: string; origin?: string; source?: string }>
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
  const label = core?.label?.trim() || undefined
  // v4：steps 只含步骤（label 单独渲染）；v3 旧数据无 steps 时回退 [label, note]
  const steps = mapping.steps?.length
    ? mapping.steps
    : mapping.note
      ? [mapping.note]
      : []
  if (!label && steps.length === 0) return undefined
  return {
    ...(label ? { label } : {}),
    coreSenseIndex: mapping.coreSenseIndex,
    steps,
    aiGenerated: core?.source === 'ai' || mapping.source === 'ai',
  }
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
  /** 该词全部本义（task-98；无则不渲染） */
  activeCoreSense: { index: number; label: string } | null
  coreSenseStats: Record<string, MeaningStat>
  coreSenseContent: {
    index: number
    label: string
    gloss?: string
    origin?: string
    mnemonic: string | null
    examples: Array<{ en: string; cn: string }>
    phrases: Array<{ en: string; cn: string }>
  } | null
  coreSenses: Array<{ label: string; note?: string; origin?: string }>
  /** w-c 当前 c 的本义→引申链（task-77；无映射 undefined） */
  memoryDerivation?: DerivationChainView
  /** F1：w-c 当前 c 的例句（最多 3） */
  memoryExamples: Array<{ en: string; cn: string }>
  /** F1：w-c 当前 c 的助记 */
  memoryMnemonics: Array<{ type: string; text: string }>
  /** F1：当前 c 不熟悉度 0–1 */
  memoryFamiliarity: number | null
  /** F1：当前 c 的不熟悉度排名（1=最不熟悉） */
  memoryRank: { rank: number; total: number } | null
  /** F6：用户笔记/助记（词级 + c 级；由 data 层写入 Word，缺省空） */
  userNotes: UserNoteView[]
  userMnemonics: UserMnemonicView[]
  memoryUserNotes: UserNoteView[]
  memoryUserMnemonics: UserMnemonicView[]
  progress: StudyProgress
  /** task-278：临时复习汇总/自评状态 */
  tempSummary: TempReviewSummary | null
  tempSession: TempReviewSession | null
  tempTotalWords: number
  tempSkipped: number
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
  /** task-268：临时复习 practice 下一个（跳过） */
  tempNext: () => void
  /** task-278：practice 自评（只存本次） */
  tempAssess: (rating: Rating) => void
  /** task-280：把本批 practice/rate-only 应用到 DHP */
  applyTempToDhp: () => Promise<void>
  /** 加权记忆：用 dev-algo weightedMemoryTotals 作为 per-c total 开始 w-c（F2） */
  openWeightedMemory: () => void
  markCoreSense: (coreSenseIndex: number, label: string) => Promise<void>
  refreshCoreSenseContent: () => void
  /** 加权记忆进行中切换只记本义/含义加权（进度重置） */
  switchWeightedCoreOnly: (coreOnly: boolean) => Promise<void>
  /** 0.11.0 P0：原子切换加权模式（normal/core/root），只 reload/open 一次 */
  setWeightedMemoryMode: (mode: 'normal' | 'core' | 'root') => Promise<void>
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
  /** F6：保存/删除用户笔记与助记（保存后重载当前词，不改学习进度） */
  saveUserNote: (input: UserNoteInput) => Promise<void>
  deleteUserNoteById: (noteId: string) => Promise<void>
  saveUserMnemonic: (input: UserMnemonicInput) => Promise<void>
  deleteUserMnemonicById: (mnemonicId: string) => Promise<void>
  /** F6：删除 AI/内置助记（隐藏原 key，不删除 AI 包数据） */
  hideAiMnemonic: (original: { meaningId?: string; type: string; text: string }) => Promise<void>
}

export function useStudySession(options?: {
  onToast?: (message: string) => void
  /** task-263：词库详情模式，只加载该词语义 session（无 plan/评分） */
  detailWordId?: string
  /** 详情模式返回路径 */
  detailReturnTo?: string
  /** task-268：临时复习词 id（一次性，不建 plan） */
  tempWordIds?: string[]
  /** practice | rate | rate-only */
  tempRecordMode?: 'practice' | 'rate' | 'rate-only'
  tempAutoRequeue?: boolean
}): StudyViewModel & { actions: StudyActions } {
  const onToast = options?.onToast
  const detailWordId = options?.detailWordId
  const tempWordIds = options?.tempWordIds
  const tempRecordMode = options?.tempRecordMode
  const tempAutoRequeue = options?.tempAutoRequeue
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
  const [coreSenseStats, setCoreSenseStats] = useState<Record<string, MeaningStat>>({})
  const [coreContentRevision, setCoreContentRevision] = useState(0)
  const [coreSenseContentFallback, setCoreSenseContentFallback] = useState<{
    index: number
    label: string
    gloss?: string
    origin?: string
    mnemonic: string | null
    examples: Array<{ en: string; cn: string }>
    phrases: Array<{ en: string; cn: string }>
  } | null>(null)
  /** 当前词的完整 WordState（供 core.previewNext 预览三键下一次出现时间） */
  const [wordState, setWordState] = useState<WordState | null>(null)
  const [plan, setPlanState] = useState<DailyPlan | null>(null)
  const [viewIndex, setViewIndex] = useState(0)
  const [browseIndex, setBrowseIndex] = useState<number | null>(null)
  const [lastChoice, setLastChoice] = useState<Rating | null>(null)
  const [learnedCount, setLearnedCount] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  const liveDetailBundle = useLiveQuery(
    () => (detailWordId ? getWordDetailBundle(detailWordId) : Promise.resolve(null)),
    [detailWordId],
  )
  useEffect(() => {
    if (!detailWordId || !liveDetailBundle) return
    setWord(liveDetailBundle.word)
    setWordState(liveDetailBundle.state)
    setMeaningStats(liveDetailBundle.state?.meaningStats ?? {})
    setCoreSenseStats(liveDetailBundle.state?.coreSenseStats ?? {})
  }, [detailWordId, liveDetailBundle])
  const tempWordsRef = useRef<Word[]>([])
  const tempIndexRef = useRef(0)
  const tempSessionRef = useRef<TempReviewSession | null>(null)
  const tempRecordsRef = useRef<TempReviewRecordInput[]>([])
  const tempBeforeRef = useRef<Map<string, TempReviewFamiliaritySnapshot>>(new Map())
  const tempStartedAtRef = useRef(0)
  const [tempSummary, setTempSummary] = useState<TempReviewSummary | null>(null)
  const [tempSkipped, setTempSkipped] = useState(0)
  const tempSkippedRef = useRef(0)
  const sessionRef = useRef<SessionState | null>(null)
  const planRef = useRef<DailyPlan | null>(null)
  const viewIndexRef = useRef(0)
  const browseRef = useRef<number | null>(null)
  const lastChoiceRef = useRef<Rating | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const learnedRef = useRef<Set<string>>(new Set())
  const studyStartedAtRef = useRef<number>(Date.now())
  const snapshotTimerRef = useRef<number | null>(null)
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
      threeTapRecall: s['memory.threeTapRecall'] !== false,
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
        meanings: (source.meanings ?? []).map((meaning) => ({
          meaningId: meaning.id,
          pos: meaning.pos,
          cn: meaning.cn,
          ...((meaning as unknown as { examples?: Array<{ en: string; cn: string }> }).examples?.length
            ? { examples: (meaning as unknown as { examples: Array<{ en: string; cn: string }> }).examples }
            : {}),
        })) as never,
        phrases: (source.phrases ?? []).map((phrase) => ({
          en: phrase.en,
          cn: phrase.cn,
          ...((phrase as { meaningId?: string }).meaningId
            ? { meaningId: (phrase as { meaningId?: string }).meaningId }
            : {}),
        })),
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
        // task-197：记忆/加权记忆的 c 列表按 hideRareMeanings 过滤（注释面用 Word 全量）
        const studyMeanings = meaningsForMemory(
          loadedWord.meanings,
          loadedWord.rareMeaningIds,
          s['study.hideRareMeanings'] !== false,
        )
        const sessionSource =
          studyMeanings.length === loadedWord.meanings.length
            ? loadedWord
            : { ...loadedWord, meanings: studyMeanings }
        let next = createSession({
          word: toSessionWord(sessionSource, s['board.showPhonetic']),
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
        setCoreSenseStats(state?.coreSenseStats ?? {})
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
      if (tempWordIds && tempWordIds.length > 0) {
        const tempSettings = await getSettings()
        const temp = await startTempReview({
          wordIds: tempWordIds,
          recordMode: tempRecordMode ?? 'rate',
          autoRequeue: tempAutoRequeue === true,
        })
        if (!mountedRef.current) return
        setSettingsState(tempSettings)
        settingsRef.current = tempSettings
        tempWordsRef.current = temp.words
        tempSessionRef.current = temp
        tempIndexRef.current = 0
        tempRecordsRef.current = []
        tempBeforeRef.current = new Map()
        tempSkippedRef.current = 0
        tempStartedAtRef.current = Date.now()
        const first = temp.words[0]!
        void captureTempReviewSnapshot(first.id).then((snap) => {
          if (snap) tempBeforeRef.current.set(first.id, snap)
        })
        const state = await getState(first.id).catch(() => null)
        setWord(first)
        setMeaningStats(state?.meaningStats ?? {})
        setCoreSenseStats(state?.coreSenseStats ?? {})
        setWordState(state ?? createWordState({ wordId: first.id, deckId: first.deckId, now: Date.now() }))
        applySession(tapBoard(createSession({
          word: toSessionWord(first, tempSettings['board.showPhonetic']),
          settings: toSessionSettings(tempSettings),
          savedCounts: {},
        })))
        applyViewIndex(0)
        applyPlan(null)
        setPhase('studying')
        return
      }
      if (detailWordId) {
        // 详情冷启动不走语义包聚合（首启内容包写入时可能很慢）；先直读 word/state/settings 渲染注释面
        const [wordRow, stateRow, detailSettings] = await Promise.all([
          getWord(detailWordId),
          getState(detailWordId).catch(() => null),
          getSettings(),
        ])
        if (!mountedRef.current) return
        if (!wordRow) {
          setErrorMessage('单词不存在或已删除')
          setPhase('error')
          return
        }
        setSettingsState(detailSettings)
        settingsRef.current = detailSettings
        setWord(wordRow)
        setMeaningStats(stateRow?.meaningStats ?? {})
        setCoreSenseStats(stateRow?.coreSenseStats ?? {})
        setWordState(stateRow ?? createWordState({ wordId: wordRow.id, deckId: wordRow.deckId, now: Date.now() }))
        const base = createSession({
          word: toSessionWord(wordRow, detailSettings['board.showPhonetic']),
          settings: toSessionSettings(detailSettings),
          savedCounts: {},
        })
        applySession(tapBoard(base))
        applyViewIndex(0)
        applyPlan(null)
        setPhase('studying')
        // encounters 异步补记，不阻塞卡片/注释面首帧
        const detailMeaningIds = wordRow.meanings.map((meaning) => meaning.id)
        if (detailMeaningIds.length > 0) {
          void recordMeaningEncounters(wordRow.id, detailMeaningIds)
            .then((updated) => {
              if (!mountedRef.current) return
              setMeaningStats(updated.meaningStats ?? {})
              setCoreSenseStats(updated.coreSenseStats ?? {})
              setWordState(updated)
            })
            .catch(() => undefined)
        }
        return
      }
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
    // task-218：本义 encounters 与 c 同一时机；先启动本义，避免 c 事务先完成导致 gate 读到旧值
    const cachedCoreSenses = (effectiveSemanticsRef.current?.coreSenses ?? [])
      .map((sense, index) => ({ index: index + 1, label: String(sense.label ?? '').trim() }))
      .filter((sense) => Boolean(sense.label))
    const coreEncountersPromise = (async () => {
      try {
        const coreSenses =
          cachedCoreSenses.length > 0
            ? cachedCoreSenses
            : ((await getEffectiveContent(next.word.wordId))?.coreSenses ?? [])
                .map((sense, index) => ({
                  index: index + 1,
                  label: String(sense.label ?? '').trim(),
                }))
                .filter((sense) => Boolean(sense.label))
        if (coreSenses.length > 0) {
          const coreUpdated = await recordCoreSenseEncounters(next.word.wordId, coreSenses)
          if (mountedRef.current) setCoreSenseStats(coreUpdated.coreSenseStats ?? {})
        }
      } catch {
        // 本义 encounters 失败不阻断学习
      }
    })()
    try {
      const updated = await recordMeaningEncounters(next.word.wordId, meaningIds)
      if (!mountedRef.current) return
      mergeStats(updated.meaningStats)
      setWordState(updated)
      await coreEncountersPromise
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
  const openWeightedNow = useCallback(() => {
    const current = sessionRef.current
    if (!current || current.stage !== 'annotation') return
    const base = current.settings.totalRepeats
    const loaded = settingsRef.current
    const weightedSettings = loaded ? weightedSettingsFromSettings(loaded) : undefined
    const wordId = current.word.wordId
    const coreOnly = loaded?.['memory.weightedCoreSenseOnly'] === true
    void (async () => {
      // 冷启动 fallback：settingsRef 可能尚未就绪，直接读 DB 最新设置，避免 reload 后退化普通加权
      let effectiveCoreOnly = coreOnly
      try {
        effectiveCoreOnly = (await getSettings())['memory.weightedCoreSenseOnly'] === true
      } catch {
        // 保持 settingsRef 结果
      }
      if (effectiveCoreOnly) {
        try {
          // 0.3.72 修复：从「只记本义」退出后再进时，word 已是 pseudo core word，
          // 直接复用其 core units 重开会话，避免重新读 effective 失败后退化成普通加权。
          const pseudoCore = current.word.meanings
            .filter((meaning) => meaning.meaningId.startsWith(CORE_SENSE_MEANING_PREFIX))
            .map((meaning) => {
              try {
                const parsed = JSON.parse(
                  meaning.meaningId.slice(CORE_SENSE_MEANING_PREFIX.length),
                ) as unknown
                if (!Array.isArray(parsed) || parsed.length !== 2) return null
                const [label, index] = parsed
                if (typeof label !== 'string' || typeof index !== 'number') return null
                return { index, label }
              } catch {
                return null
              }
            })
            .filter((item): item is { index: number; label: string } => Boolean(item))
          if (pseudoCore.length > 0) {
            const stats = await getCoreSenseStats(wordId)
            const built = buildCoreSenseWeightedUnits({
              base,
              coreSenses: pseudoCore,
              coreSenseStats: stats,
              settings: weightedSettings,
              rareCoreSenses: [],
            })
            if (built.hasUsable) {
              // 冷启动首帧：在打开 core 会话前预取当前本义内容，避免 MemoryStage 首屏空内容
              const firstUnit = built.units[0]
              if (firstUnit) {
                try {
                  const exampleCount = Math.max(
                    0,
                    Math.min(3, (await getSettings())['memory.coreSenseExampleCount'] ?? 2),
                  )
                  const phraseCount = Math.max(
                    0,
                    Math.min(3, (await getSettings())['memory.coreSensePhraseCount'] ?? 2),
                  )
                  const [mnemonicRows, reps, exampleViews, phraseViews] = await Promise.all([
                    listSenseMnemonics(wordId),
                    listCoreSenseRepresentatives(wordId, Math.max(exampleCount, phraseCount, 1)),
                    listCoreSenseExampleViews(wordId),
                    listCoreSensePhraseViews(wordId),
                  ])
                  const mnemonicRow =
                    mnemonicRows.find((row) => row.label.trim() === firstUnit.label.trim()) ??
                    mnemonicRows.find((row) => row.coreSenseIndex === firstUnit.index) ??
                    ((await getWord(wordId))?.senseMnemonics ?? []).find((row) => row.label.trim() === firstUnit.label.trim()) ??
                    null
                  const representative = reps.find((item) => item.coreSenseIndex === firstUnit.index) ?? null
                  const savedExamples =
                    pickCoreSenseEntry(exampleViews.current, firstUnit) ??
                    ((await getWord(wordId))?.coreSenseExamples ?? []).find(
                      (entry) => entry.label.trim() === firstUnit.label.trim(),
                    ) ??
                    ((await getWord(wordId))?.coreSenseExamples ?? []).find(
                      (entry) => entry.coreSenseIndex === firstUnit.index,
                    ) ??
                    null
                  const savedPhrases =
                    pickCoreSenseEntry(phraseViews.current, firstUnit) ??
                    ((await getWord(wordId))?.coreSensePhrases ?? []).find(
                      (entry) => entry.label.trim() === firstUnit.label.trim(),
                    ) ??
                    ((await getWord(wordId))?.coreSensePhrases ?? []).find(
                      (entry) => entry.coreSenseIndex === firstUnit.index,
                    ) ??
                    null
                  const display = coreSenseDisplayContent({
                    exampleCount,
                    phraseCount,
                    representative,
                    savedExamples,
                    savedPhrases,
                  })
                  setCoreSenseContentFallback({
                    index: firstUnit.index,
                    label: firstUnit.label,
                    ...(representative?.gloss ? { gloss: representative.gloss } : {}),
                    ...(representative?.origin ? { origin: representative.origin } : {}),
                    mnemonic: mnemonicRow?.text ?? null,
                    examples: display.examples,
                    phrases: display.phrases,
                  })
                } catch {
                  // 预取失败时仍由 fallback effect 兜底
                }
              }
              const pseudo = toCoreSenseSessionWord(current.word, built.units)
              const next = openMemory(
                tapBoard(
                  createSession({
                    word: pseudo,
                    settings: current.settings,
                    weightedTotals: built.totals,
                  }),
                ),
              )
              if (next.stage === 'memory') {
                if (sessionRef.current?.word.wordId !== wordId || submittingRef.current) return
                applySession(next)
                scheduleSnapshot()
                return
              }
            }
          }
          const [effective, wordRow, stats] = await Promise.all([
            getEffectiveContent(wordId),
            getWord(wordId),
            getCoreSenseStats(wordId),
          ])
          let coreSenses = (effective?.coreSenses ?? [])
            .filter((sense) => Boolean(sense.label))
            .map((sense) => ({ index: sense.index, label: sense.label }))
          let usedSavedFallback = false
          if (coreSenses.length === 0 && wordRow) {
            // 冷启动 effective 为空时，用已保存内容/rare 快照的 label+index 兜底建 units
            const byLabel = new Map<string, { index: number; label: string }>()
            const add = (entry: { coreSenseIndex?: number; label?: string } | null | undefined) => {
              const label = String(entry?.label ?? '').trim()
              const index = Math.trunc(Number(entry?.coreSenseIndex))
              if (!label || !Number.isFinite(index) || index < 1) return
              if (!byLabel.has(label)) byLabel.set(label, { index, label })
            }
            for (const entry of wordRow.senseMnemonics ?? []) add(entry)
            for (const entry of wordRow.coreSenseExamples ?? []) add(entry)
            for (const entry of wordRow.coreSensePhrases ?? []) add(entry)
            for (const entry of wordRow.rareCoreSenses ?? []) add(entry)
            coreSenses = [...byLabel.values()].sort((a, b) => a.index - b.index)
            usedSavedFallback = coreSenses.length > 0
          }
          const built = buildCoreSenseWeightedUnits({
            base,
            coreSenses,
            coreSenseStats: stats,
            settings: weightedSettings,
            rareCoreSenses: usedSavedFallback ? [] : wordRow?.rareCoreSenses,
          })
          if (!built.hasUsable || built.units.length === 0) {
            toast('该词暂无可用本义，已回退普通加权记忆')
          } else {
            const pseudo = toCoreSenseSessionWord(current.word, built.units)
            const coreSession = openMemory(
              tapBoard(
                createSession({
                  word: pseudo,
                  settings: current.settings,
                  weightedTotals: built.totals,
                }),
              ),
            )
            if (coreSession.stage === 'memory') {
              applySession(coreSession)
              scheduleSnapshot()
              return
            }
          }
        } catch (error) {
          toast(`只记本义加权失败：${errorMessageOf(error)}`)
        }
      }
      // task-236：以 DB 最新 states 为准（避免 seed/外部写入后 hook 缓存 stale 导致 weightedTotals=base）
      let latestMeaningStats = meaningStats
      try {
        const latestState = await getState(current.word.wordId)
        if (latestState?.meaningStats) latestMeaningStats = latestState.meaningStats
      } catch {
        // 保持缓存
      }
      const familiarityByMeaning: Record<string, number | null> = {}
      for (const meaning of current.word.meanings) {
        // 兼容 SessionWord(meaningId) 与 Word(id) 两种形状
        const meaningKey = sessionMeaningIdOf(
          meaning as { meaningId?: string; id?: string },
        )
        if (!meaningKey) continue
        const stat = normalizeMeaningStat(latestMeaningStats[meaningKey])
        familiarityByMeaning[meaningKey] = familiarity(stat.clicks, stat.encounters)
      }
      const weightedTotals = weightedMemoryTotals(base, familiarityByMeaning, weightedSettings)
      const fresh = createSession({
        word: current.word,
        settings: current.settings,
        weightedTotals,
      })
      const annotated = tapBoard(fresh)
      const next = openMemory(annotated)
      if (next.stage !== 'memory') return
      if (sessionRef.current?.word.wordId !== wordId || submittingRef.current) return
      applySession(next)
      scheduleSnapshot()
    })()
  }, [applySession, meaningStats, scheduleSnapshot, toast])

  const handleOpenWeightedMemory = useCallback(() => {
    openWeightedNow()
  }, [openWeightedNow])

  /** 0.3.70：加权记忆进行中切换「只记本义」——回到注释面按新模式重开（进度重置） */
  const handleSwitchWeightedCoreOnly = useCallback(
    async (coreOnly: boolean) => {
      const current = sessionRef.current
      const currentPlan = planRef.current
      const loaded = settingsRef.current
      if (!current || current.stage !== 'memory' || !currentPlan || !loaded) return
      const nextSettings = { ...loaded, 'memory.weightedCoreSenseOnly': coreOnly }
      settingsRef.current = nextSettings
      await updateSettings({ 'memory.weightedCoreSenseOnly': coreOnly })
      await loadWordAt(currentPlan.index, currentPlan, nextSettings, { startAt: 'annotation' })
      openWeightedNow()
      toast(
        coreOnly
          ? '已切换为只记本义，本次进度已重置'
          : '已恢复含义加权，本次进度已重置',
      )
    },
    [loadWordAt, openWeightedNow, toast],
  )
  const handleSetWeightedMemoryMode = useCallback(
    async (mode: 'normal' | 'core' | 'root') => {
      const current = sessionRef.current
      const currentPlan = planRef.current
      const loaded = settingsRef.current
      if (!current || current.stage !== 'memory' || !currentPlan || !loaded) return
      const coreOnly = mode === 'core'
      const rootOnly = mode === 'root'
      const nextSettings = {
        ...loaded,
        'memory.weightedCoreSenseOnly': coreOnly,
        'memory.rootAffixOnly': rootOnly,
      }
      settingsRef.current = nextSettings
      const updated = await updateSettings({
        'memory.weightedCoreSenseOnly': coreOnly,
        'memory.rootAffixOnly': rootOnly,
      })
      if (mountedRef.current) setSettingsState(updated)
      settingsRef.current = updated
      await loadWordAt(currentPlan.index, currentPlan, updated, { startAt: 'annotation' })
      openWeightedNow()
      toast(
        mode === 'core'
          ? '已切换为只记本义，本次进度已重置'
          : mode === 'root'
            ? '已切换为只记词根缀，本次进度已重置'
            : '已恢复含义加权，本次进度已重置',
      )
    },
    [loadWordAt, openWeightedNow, toast],
  )

  /** task-218：本义点击 +clicks（独立 stats），与 encounters 同源状态 */
  const handleMarkCoreSense = useCallback(
    async (coreSenseIndex: number, label: string) => {
      const current = sessionRef.current
      if (!current) return
      setCoreSenseStats((prev) => {
        const key = JSON.stringify([label.trim(), coreSenseIndex])
        const stat = prev[key] ?? { clicks: 0, encounters: 0 }
        return { ...prev, [key]: { clicks: stat.clicks + 1, encounters: stat.encounters } }
      })
      try {
        const updated = await recordCoreSenseClick(current.word.wordId, {
          index: coreSenseIndex,
          label,
        })
        if (mountedRef.current) setCoreSenseStats(updated.coreSenseStats ?? {})
      } catch (error) {
        toast(`保存本义不熟悉度失败：${errorMessageOf(error)}`)
      }
    },
    [toast],
  )

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
    // task-252：不再自动切页；core.tapMemory 在 needsAdvance 时由用户这一次 tap 内部 advance
    const tapped = tapMemory(current)
    applySession(tapped)
    scheduleSnapshot()
    if (tapped.stage === 'annotation') {
      clearTimer(snapshotTimerRef)
      void saveSessionSnapshot(sessionSnapshot(tapped)).catch(() => undefined)
      toast('记忆完成，可再次点击继续')
    }
  }, [applySession, clearTimer, scheduleSnapshot, toast])

  const handleExitMemory = useCallback(() => {
    const current = sessionRef.current
    if (!current || current.stage !== 'memory') return
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

  const loadTempWord = useCallback(async (index: number) => {
    const words = tempWordsRef.current
    const loadedSettings = settingsRef.current
    const queue = tempSessionRef.current?.queue
    const queueItem = queue?.[index]
    if (!loadedSettings || !queueItem) {
      return false
    }
    const next = words.find((word) => word.id === queueItem.wordId)
    if (!next) return false
    tempIndexRef.current = index
    tempStartedAtRef.current = Date.now()
    void captureTempReviewSnapshot(next.id).then((snap) => {
      if (snap && !tempBeforeRef.current.has(next.id)) tempBeforeRef.current.set(next.id, snap)
    })
    const state = await getState(next.id).catch(() => null)
    setWord(next)
    setMeaningStats(state?.meaningStats ?? {})
    setCoreSenseStats(state?.coreSenseStats ?? {})
    setWordState(state ?? createWordState({ wordId: next.id, deckId: next.deckId, now: Date.now() }))
    applySession(tapBoard(createSession({
      word: toSessionWord(next, loadedSettings['board.showPhonetic']),
      settings: toSessionSettings(loadedSettings),
      savedCounts: {},
    })))
    applyBrowse(null)
    applyLastChoice(null)
    setPhase('studying')
    return true
  }, [applyBrowse, applyLastChoice, applySession, toSessionSettings, toSessionWord])

  const finishTemp = useCallback(async () => {
    const session = tempSessionRef.current
    if (!session) return
    const summary =
      session.recordMode === 'practice'
        ? await summarizePracticeReview(session)
        : await summarizeTempReview(session, tempRecordsRef.current)
    setTempSummary(summary)
  }, [])

  const advanceTemp = useCallback(async () => {
    const nextIndex = tempIndexRef.current + 1
    const loaded = await loadTempWord(nextIndex)
    if (!loaded) await finishTemp()
  }, [finishTemp, loadTempWord])

  const handleRate = useCallback(
    async (rating: Rating) => {
      const current = sessionRef.current
      const loadedSettings = settingsRef.current
      if (!current || submittingRef.current || !loadedSettings) return
      if (tempWordIds && tempWordIds.length > 0) {
        submittingRef.current = true
        setSubmitting(true)
        try {
          if (tempRecordMode !== 'practice') {
            await rateTempReview({ wordId: current.word.wordId, rating, recordMode: tempRecordMode ?? 'rate' })
          }
          const durationMs = Date.now() - tempStartedAtRef.current
          tempRecordsRef.current.push({
            wordId: current.word.wordId,
            rating,
            durationMs,
            ...(tempBeforeRef.current.get(current.word.wordId)
              ? { before: tempBeforeRef.current.get(current.word.wordId)! }
              : {}),
          })
          const session = tempSessionRef.current
          if (session) {
            tempSessionRef.current = advanceTempReviewBatch(session, {
              queueIndex: tempIndexRef.current,
              rating,
              durationMs,
            })
          }
          await advanceTemp()
        } finally {
          submittingRef.current = false
          setSubmitting(false)
        }
        return
      }
      submittingRef.current = true
      setSubmitting(true)
      const perfStart = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const wordId = current.word.wordId
      const planBefore = planRef.current
      const browsing = browseRef.current != null
      const previousChoice = lastChoiceRef.current
      let submitted = false
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

        submitted = true
        if (browsing && !outcome.reverted) {
          toast('这条反馈已无法撤销，无法改判')
          return
        }
        // rateInPlan/submitRatingSqlite 已在同一流程内把最新 plan 写入 IDB cache，
        // 直接使用返回的 plan，避免每次评分再走 getTodayPlan（旧 plan 清理 + 原生查询）造成 1–2s 延迟。
        let planAfter: DailyPlan | null = outcome.plan
        if (typeof localStorage !== 'undefined') {
          const perfMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - perfStart)
          try {
            const prev = JSON.parse(localStorage.getItem('momo:rate-perf') ?? '[]') as number[]
            localStorage.setItem('momo:rate-perf', JSON.stringify([...prev.slice(-19), perfMs]))
          } catch { /* ignore */ }
        }
        // task-275：生产包 console 可能被 strip；写 localStorage 诊断供 QA dump
        try {
          const diagKey = 'momo:rate-diag'
          const item = {
            at: Date.now(),
            wordId,
            rating,
            browsing,
            planId: planBefore?.id ?? null,
            before: planBefore
              ? { index: planBefore.index, len: planBefore.wordIds.length, completedAt: planBefore.completedAt, ratings: planBefore.ratings.length }
              : null,
            after: planAfter
              ? {
                  id: planAfter.id,
                  index: planAfter.index,
                  len: planAfter.wordIds.length,
                  completedAt: planAfter.completedAt,
                  ratings: planAfter.ratings.length,
                  tail: planAfter.wordIds.slice(-3),
                }
              : null,
          }
          if (typeof localStorage !== 'undefined') {
            const prevRaw = localStorage.getItem(diagKey)
            const prev = prevRaw ? (JSON.parse(prevRaw) as unknown[]) : []
            localStorage.setItem(diagKey, JSON.stringify([...prev.slice(-19), item]))
          }
        } catch {
          /* 诊断失败不影响评分 */
        }
        if (typeof console !== 'undefined') {
          console.debug('[rate]', {
            wordId,
            rating,
            before: planBefore ? { index: planBefore.index, len: planBefore.wordIds.length, completedAt: planBefore.completedAt } : null,
            after: planAfter ? { index: planAfter.index, len: planAfter.wordIds.length, completedAt: planAfter.completedAt, last: planAfter.wordIds[planAfter.wordIds.length - 1] } : null,
          })
        }
        if (browsing) {
          const before = previousChoice ? RATING_LABEL[previousChoice] : '上一次'
          toast(`已将「${before}」改为「${RATING_LABEL[rating]}」，计划已更新`)
        }
        scheduleProgressCheckpoint()
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

        // 0.3.93：只按 index 判断；completedAt 可能是回炉插入前的旧值，不能单独作为结束依据
        if (!planAfter || planAfter.index >= planAfter.wordIds.length) {
          applySession(null)
          setWord(null)
          setPhase(learnedRef.current.size > 0 ? 'done' : 'empty')
          return
        }
        await loadWordAt(planAfter.index, planAfter, loadedSettings)
      } catch (error) {
        // 评分已成功但后续加载下一词失败时，不能说“提交失败”，否则用户会重复评分
        toast(submitted ? `已保存，但加载下一词失败：${errorMessageOf(error)}` : `提交失败，请重试：${errorMessageOf(error)}`)
      } finally {
        submittingRef.current = false
        if (mountedRef.current) setSubmitting(false)
      }
    },
    [applyBrowse, applyLastChoice, applyPlan, applySession, loadWordAt, toast],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const flush = () => {
      void flushProgressCheckpoint()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

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

  const refreshUserContent = useCallback(async () => {
    const wordId = sessionRef.current?.word.wordId
    if (!wordId) return
    const fresh = await getWord(wordId)
    if (fresh && mountedRef.current && sessionRef.current?.word.wordId === wordId) setWord(fresh)
  }, [])

  const saveUserNote = useCallback(
    async (input: UserNoteInput) => {
      const wordId = sessionRef.current?.word.wordId
      if (!wordId) return
      await upsertUserNote(wordId, input)
      await refreshUserContent()
    },
    [refreshUserContent],
  )

  const deleteUserNoteById = useCallback(
    async (noteId: string) => {
      const wordId = sessionRef.current?.word.wordId
      if (!wordId) return
      await deleteUserNote(wordId, noteId)
      await refreshUserContent()
    },
    [refreshUserContent],
  )

  const saveUserMnemonic = useCallback(
    async (input: UserMnemonicInput) => {
      const wordId = sessionRef.current?.word.wordId
      if (!wordId) return
      await upsertUserMnemonic(wordId, input)
      await refreshUserContent()
    },
    [refreshUserContent],
  )

  const deleteUserMnemonicById = useCallback(
    async (mnemonicId: string) => {
      const wordId = sessionRef.current?.word.wordId
      if (!wordId) return
      await deleteUserMnemonic(wordId, mnemonicId)
      await refreshUserContent()
    },
    [refreshUserContent],
  )

  const hideAiMnemonic = useCallback(
    async (original: { meaningId?: string; type: string; text: string }) => {
      const wordId = sessionRef.current?.word.wordId
      if (!wordId) return
      await deleteAiMnemonic(wordId, original)
      await refreshUserContent()
    },
    [refreshUserContent],
  )

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

  const effectiveSemanticsRef = useRef<EffectiveSemantics | null>(null)
  useEffect(() => {
    effectiveSemanticsRef.current = effectiveSemantics ?? null
  }, [effectiveSemantics])

  const activeCoreSense = useMemo<{ index: number; label: string } | null>(() => {
    const id =
      session?.activeMeaningId?.startsWith(CORE_SENSE_MEANING_PREFIX)
        ? session.activeMeaningId
        : session?.word.meanings.find((meaning) =>
            meaning.meaningId.startsWith(CORE_SENSE_MEANING_PREFIX),
          )?.meaningId
    if (!id?.startsWith(CORE_SENSE_MEANING_PREFIX)) return null
    try {
      const parsed = JSON.parse(id.slice(CORE_SENSE_MEANING_PREFIX.length)) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 2) return null
      const [label, index] = parsed
      if (typeof label !== 'string' || typeof index !== 'number') return null
      return { index, label }
    } catch {
      return null
    }
  }, [session?.activeMeaningId, session?.word.meanings])

  const coreSenseContent = useLiveQuery(async () => {
    const wordId = session?.word.wordId
    const core = activeCoreSense
    if (!wordId || !core) return null
    const exampleCount = Math.max(0, Math.min(3, settings?.['memory.coreSenseExampleCount'] ?? 2))
    const phraseCount = Math.max(0, Math.min(3, settings?.['memory.coreSensePhraseCount'] ?? 2))
    const [representatives, mnemonics, exampleViews, phraseViews] = await Promise.all([
      listCoreSenseRepresentatives(wordId, Math.max(exampleCount, phraseCount, 1)),
      listSenseMnemonics(wordId),
      listCoreSenseExampleViews(wordId),
      listCoreSensePhraseViews(wordId),
    ])
    const representative =
      representatives.find((item) => item.label.trim() === core.label.trim()) ??
      representatives.find((item) => item.coreSenseIndex === core.index) ??
      null
    const mnemonic =
      mnemonics.find((item) => item.label.trim() === core.label.trim()) ??
      mnemonics.find((item) => item.coreSenseIndex === core.index) ??
      null
    const savedExamples = pickCoreSenseEntry(exampleViews.current, core)
    const savedPhrases = pickCoreSenseEntry(phraseViews.current, core)
    const display = coreSenseDisplayContent({
      exampleCount,
      phraseCount,
      representative,
      savedExamples,
      savedPhrases,
    })
    return {
      index: core.index,
      label: core.label,
      gloss: effectiveSemantics?.coreSenses?.find(
        (sense) => String(sense.label ?? '').trim() === core.label.trim(),
      )?.note,
      origin: effectiveSemantics?.coreSenses?.find(
        (sense) => String(sense.label ?? '').trim() === core.label.trim(),
      )?.origin,
      mnemonic: mnemonic?.text ?? null,
      examples: display.examples,
      phrases: display.phrases,
    }
  }, [
    session?.word.wordId,
    activeCoreSense?.index,
    activeCoreSense?.label,
    settings?.['memory.coreSenseExampleCount'],
    settings?.['memory.coreSensePhraseCount'],
    effectiveSemantics,
    session?.stage,
  ])

  // task-220 冷启动兜底：不依赖 liveQuery 首帧，mounted/会话切换时主动拉取一次已保存本义内容
  useEffect(() => {
    const wordId = session?.word.wordId
    const core = activeCoreSense
    if (!wordId || !core) {
      setCoreSenseContentFallback(null)
      return
    }
    let alive = true
    const exampleCount = Math.max(0, Math.min(3, settings?.['memory.coreSenseExampleCount'] ?? 2))
    const phraseCount = Math.max(0, Math.min(3, settings?.['memory.coreSensePhraseCount'] ?? 2))
    void (async () => {
      try {
        const [representatives, mnemonics, exampleViews, phraseViews, wordRow] = await Promise.all([
          listCoreSenseRepresentatives(wordId, Math.max(exampleCount, phraseCount, 1)),
          listSenseMnemonics(wordId),
          listCoreSenseExampleViews(wordId),
          listCoreSensePhraseViews(wordId),
          getWord(wordId),
        ])
        const representative =
          representatives.find((item) => item.label.trim() === core.label.trim()) ??
          representatives.find((item) => item.coreSenseIndex === core.index) ??
          null
        const mnemonic =
          mnemonics.find((item) => item.label.trim() === core.label.trim()) ??
          mnemonics.find((item) => item.coreSenseIndex === core.index) ??
          null
        const savedExamples =
          pickCoreSenseEntry(exampleViews.current, core) ??
          (wordRow?.coreSenseExamples ?? []).find(
            (entry) => entry.label.trim() === core.label.trim(),
          ) ??
          (wordRow?.coreSenseExamples ?? []).find(
            (entry) => entry.coreSenseIndex === core.index,
          ) ??
          null
        const savedPhrases =
          pickCoreSenseEntry(phraseViews.current, core) ??
          (wordRow?.coreSensePhrases ?? []).find(
            (entry) => entry.label.trim() === core.label.trim(),
          ) ??
          (wordRow?.coreSensePhrases ?? []).find(
            (entry) => entry.coreSenseIndex === core.index,
          ) ??
          null
        const display = coreSenseDisplayContent({
          exampleCount,
          phraseCount,
          representative,
          savedExamples,
          savedPhrases,
        })
        if (!alive) return
        setCoreSenseContentFallback({
          index: core.index,
          label: core.label,
          gloss:
            representative?.gloss ??
            effectiveSemantics?.coreSenses?.find(
              (sense) => String(sense.label ?? '').trim() === core.label.trim(),
            )?.note,
          origin:
            representative?.origin ??
            effectiveSemantics?.coreSenses?.find(
              (sense) => String(sense.label ?? '').trim() === core.label.trim(),
            )?.origin,
          mnemonic: mnemonic?.text ?? null,
          examples: display.examples,
          phrases: display.phrases,
        })
      } catch {
        // 保持 liveQuery 结果/空
      }
    })()
    return () => {
      alive = false
    }
  }, [
    session?.word.wordId,
    session?.stage,
    activeCoreSense?.index,
    activeCoreSense?.label,
    settings?.['memory.coreSenseExampleCount'],
    settings?.['memory.coreSensePhraseCount'],
    effectiveSemantics,
    coreContentRevision,
  ])

  const mergedCoreSenseContent = useMemo(() => {
    const live = coreSenseContent
    const fallback = coreSenseContentFallback
    if (!live) return fallback
    if (!fallback) return live
    return {
      ...live,
      gloss: live.gloss ?? fallback.gloss,
      origin: live.origin ?? fallback.origin,
      mnemonic: live.mnemonic ?? fallback.mnemonic,
      examples: live.examples.length > 0 ? live.examples : fallback.examples,
      phrases: live.phrases.length > 0 ? live.phrases : fallback.phrases,
    }
  }, [coreSenseContent, coreSenseContentFallback])

  const meanings = useMemo<MeaningView[]>(() => {
    if (!session) return []
    const sourceMeanings =
      word?.meanings?.map((meaning) => ({
        meaningId: meaning.id,
        pos: meaning.pos,
        cn: meaning.cn,
      })) ?? session.word.meanings
    return sourceMeanings.map((meaning, index) => {
      const stat = normalizeMeaningStat(meaningStats[meaning.meaningId])
      return {
        meaningId: meaning.meaningId,
        pos: meaning.pos,
        cn: meaning.cn,
        clicks: stat.clicks,
        encounters: stat.encounters,
        familiarity: familiarity(stat.clicks, stat.encounters),
        ...(() => {
          const fromSession = (meaning as unknown as { examples?: Array<{ en: string; cn: string }> })
            .examples
          const sourceMeaning = word?.meanings.find((item) => item.id === meaning.meaningId)
          const fromWord = (sourceMeaning as unknown as { examples?: Array<{ en: string; cn: string }> })
            ?.examples
          const examples = fromWord?.length ? fromWord : fromSession
          return examples?.length ? { examples } : {}
        })(),
        derivation: derivationFor(effectiveSemantics, index + 1),
      }
    })
  }, [effectiveSemantics, meaningStats, session, word])

  const examples = useMemo<ExampleView[]>(() => {
    if (!word) return []
    return word.examples.map((example) => ({ en: example.en, cn: example.cn }))
  }, [word])


  const mnemonics = useMemo<MnemonicView[]>(() => {
    // A1：AI/内置助记直接由 Word.mnemonics 同步计算（过滤 hidden、用户副本覆盖），
    // AI apply/reload 后立即可见，不依赖异步 merged 列表。
    return visibleMnemonics(word as never)
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
  const memoryTotal =
    session && session.activeMeaningId
      ? memoryTotalForMeaning(session, session.activeMeaningId)
      : session
        ? session.settings.totalRepeats
        : 3
  const minutes = Math.max(1, Math.round((Date.now() - studyStartedAtRef.current) / 60_000))

  return {
    phase,
    tempSummary,
    tempSession: tempSessionRef.current,
    tempTotalWords: tempWordsRef.current.length,
    tempSkipped,
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
    memoryExamples: (() => {
      if (!session?.activeMeaningId || !word) return []
      const source = word.meanings.find((meaning) => meaning.id === session.activeMeaningId)
      const examples = (source as unknown as { examples?: Array<{ en: string; cn: string }> })?.examples
      return (examples ?? []).slice(0, 3)
    })(),
    memoryMnemonics: (() => {
      if (!session?.activeMeaningId) return []
      return visibleMnemonics(word as never)
        .filter(
          (mnemonic) =>
            mnemonic.meaningId === session.activeMeaningId,
        )
        .map((mnemonic) => ({ type: mnemonic.type, text: mnemonic.text }))
    })(),
    memoryFamiliarity: (() => {
      if (!session?.activeMeaningId) return null
      const stat = normalizeMeaningStat(meaningStats[session.activeMeaningId])
      return familiarity(stat.clicks, stat.encounters)
    })(),
    userNotes: (word?.userNotes ?? []).map((note) => ({ id: note.id, text: note.text, ...(note.meaningId ? { meaningId: note.meaningId } : {}) })),
    userMnemonics: (word?.userMnemonics ?? []).map((item) => ({
      id: item.id,
      type: item.type,
      text: item.text,
      ...(item.meaningId ? { meaningId: item.meaningId } : {}),
    })),
    memoryUserNotes: (() => {
      if (!session?.activeMeaningId) return []
      return (word?.userNotes ?? [])
        .filter((note) => note.meaningId === session.activeMeaningId)
        .map((note) => ({ id: note.id, text: note.text, meaningId: note.meaningId }))
    })(),
    memoryUserMnemonics: (() => {
      if (!session?.activeMeaningId) return []
      return (word?.userMnemonics ?? [])
        .filter((mnemonic) => mnemonic.meaningId === session.activeMeaningId)
        .map((mnemonic) => ({
          id: mnemonic.id,
          type: mnemonic.type,
          text: mnemonic.text,
          meaningId: mnemonic.meaningId,
        }))
    })(),
    memoryRank: (() => {
      if (!session?.activeMeaningId || session.word.meanings.length === 0) return null
      const scored = session.word.meanings.map((meaning, index) => {
        const stat = normalizeMeaningStat(meaningStats[meaning.meaningId])
        return { meaningId: meaning.meaningId, score: familiarity(stat.clicks, stat.encounters) ?? 0, index }
      })
      const sorted = [...scored].sort((a, b) => b.score - a.score || a.index - b.index)
      const position = sorted.findIndex((item) => item.meaningId === session.activeMeaningId)
      return position >= 0 ? { rank: position + 1, total: sorted.length } : null
    })(),
    activeCoreSense,
    coreSenseStats,
    coreSenseContent: mergedCoreSenseContent,
    coreSenses: (effectiveSemantics?.coreSenses ?? [])
      .filter(
        (sense): sense is { label: string; note?: string; origin?: string } =>
          Boolean(sense.label),
      )
      .map((sense) => ({
        label: sense.label,
        ...(sense.note ? { note: sense.note } : {}),
        ...(sense.origin ? { origin: sense.origin } : {}),
      })),
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
      tempNext: () => {
        void (async () => {
          const current = sessionRef.current
          if (current) {
            tempSkippedRef.current += 1
            setTempSkipped(tempSkippedRef.current)
          }
          await advanceTemp()
        })()
      },
      applyTempToDhp: async () => {
        const session = tempSessionRef.current
        if (!session) return
        const result = await applyTempReviewToDhp(session)
        tempSessionRef.current = result.session
      },
      tempAssess: (rating: Rating) => {
        void (async () => {
          const current = sessionRef.current
          if (!current) return
          const durationMs = Date.now() - tempStartedAtRef.current
          tempRecordsRef.current.push({
            wordId: current.word.wordId,
            rating,
            durationMs,
            ...(tempBeforeRef.current.get(current.word.wordId)
              ? { before: tempBeforeRef.current.get(current.word.wordId)! }
              : {}),
          })
          const session = tempSessionRef.current
          if (session) {
            tempSessionRef.current = advanceTempReviewBatch(session, {
              queueIndex: tempIndexRef.current,
              rating,
              durationMs,
            })
          }
          await advanceTemp()
        })()
      },
      openWeightedMemory: handleOpenWeightedMemory,
      markCoreSense: handleMarkCoreSense,
      refreshCoreSenseContent: () => setCoreContentRevision((value) => value + 1),
    switchWeightedCoreOnly: handleSwitchWeightedCoreOnly,
    setWeightedMemoryMode: handleSetWeightedMemoryMode,
      memoryTap: handleMemoryTap,
      exitMemory: handleExitMemory,
      updateStudySettings: handleUpdateStudySettings,
      flushSnapshot: handleFlushSnapshot,
      goBack: handleGoBack,
      continueForward: handleContinueForward,
      refreshPlan: handleRefreshPlan,
      reloadCurrentWord: handleReloadCurrentWord,
      saveUserNote,
      deleteUserNoteById,
      saveUserMnemonic,
      deleteUserMnemonicById,
      hideAiMnemonic,
    },
  }
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}
