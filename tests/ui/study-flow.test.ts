/**
 * 学习链路集成测试（task-9）：
 * 用 fake-indexeddb 驱动「队列 → 会话 → encounters/clicks → 记忆 → 评分 → 下一词 → 快照恢复」，
 * 验证 useStudySession 所依赖的 core/data 契约（不渲染 React，node 环境跑得快）。
 */
import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  advanceMemory,
  createSession,
  createWordState,
  predictAll,
  exitMemory,
  familiarity,
  isMemoryComplete,
  openMemory,
  sessionSnapshot,
  tapBoard,
  tapMemory,
} from '../../src/core'
import {
  deleteSessionSnapshot,
  ensureBuiltinDecks,
  getDb,
  getSettings,
  getState,
  getTodayQueue,
  getWord,
  loadSessionSnapshot,
  recordMeaningClick,
  recordMeaningEncounters,
  resetDatabase,
  saveSessionSnapshot,
  submitRating,
} from '../../src/data'
import { formatOfficialHint } from '../../src/ui/study/lib/next-hint'

const DAILY_GOAL = 3
const REPEATS = 3

/**
 * 公开树默认 deck 与私版不同（dagang vs 受限商业词表），首词可能只有 1 个含义。
 * w-c 顺序模式测试需要「含义数 ≥ 2」的词才能验证 advance 到下一个 c；
 * 这里遍历当前 deck 词，动态挑含义数最多的（不硬编码词/词库 id）。
 */
async function loadWordWithMostMeanings() {
  const settings = await getSettings()
  const deckId = settings['data.selectedDeckId']
  const db = getDb()
  const scan = async (limit: number) =>
    db.words.where('deckId').equals(deckId).limit(limit).toArray()
  let words = await scan(400)
  if (!words.some((candidate) => candidate.meanings.length >= 2)) {
    words = await db.words.where('deckId').equals(deckId).toArray()
  }
  const word = words.reduce(
    (best, candidate) =>
      candidate.meanings.length > best.meanings.length ? candidate : best,
    words[0]!,
  )
  expect(word).toBeTruthy()
  expect(word.meanings.length).toBeGreaterThanOrEqual(2)
  const state = await getState(word.id)
  return { word: word!, state, wordId: word.id, deckId }
}

async function loadFirstWord() {
  const settings = await getSettings()
  const deckId = settings['data.selectedDeckId']
  const queue = await getTodayQueue({ deckId, dailyGoal: DAILY_GOAL })
  const wordId = queue.newQueue[0]?.wordId ?? queue.reviewQueue[0]?.wordId
  expect(wordId).toBeTruthy()
  const word = await getWord(wordId!)
  expect(word).toBeTruthy()
  const state = await getState(wordId!)
  return { word: word!, state, wordId: wordId!, deckId }
}

describe('学习链路（core session × data 持久化）', () => {
  beforeEach(async () => {
    await resetDatabase()
    await ensureBuiltinDecks()
  })

  it('内置词库 + 今日队列：新词按词序进入队列', async () => {
    const settings = await getSettings()
    const queue = await getTodayQueue({
      deckId: settings['data.selectedDeckId'],
      dailyGoal: DAILY_GOAL,
    })
    expect(queue.newQueue.length).toBe(DAILY_GOAL)
    expect(queue.reviewQueue.length).toBe(0)
    expect(queue.totalPlanned).toBe(DAILY_GOAL)
  })

  it('白板→注释：encounters 全部含义 +1；点含义 clicks+1；familiarity 正确', async () => {
    const { word, state } = await loadFirstWord()
    // 未学词懒创建：可能没有 state 行（按 0/0 兜底）
    expect(state == null || state.meaningStats).toBeTruthy()

    const session = createSession({
      word: {
        wordId: word.id,
        deckId: word.deckId,
        headword: word.headword,
        meanings: word.meanings.map((meaning) => ({
          meaningId: meaning.id,
          pos: meaning.pos,
          cn: meaning.cn,
        })),
        phrases: word.phrases,
      },
      settings: {
        totalRepeats: REPEATS,
        mode: 'sequential',
        showPhrases: true,
        exampleCount: 2,
        showPhonetic: true,
      },
    })
    expect(session.stage).toBe('board')

    // UI 在 tapBoard 前判断 shouldRecordEncounters；这里直接记录（模拟 hook 顺序）
    const afterEncounter = await recordMeaningEncounters(
      word.id,
      word.meanings.map((meaning) => meaning.id),
    )
    for (const meaning of word.meanings) {
      expect(afterEncounter.meaningStats[meaning.id]?.encounters).toBe(1)
    }
    const annotated = tapBoard(session)
    expect(annotated.stage).toBe('annotation')

    const firstMeaning = word.meanings[0]!
    const afterClick = await recordMeaningClick(word.id, firstMeaning.id)
    expect(afterClick.meaningStats[firstMeaning.id]?.clicks).toBe(1)
    expect(
      familiarity(
        afterClick.meaningStats[firstMeaning.id]!.clicks,
        afterClick.meaningStats[firstMeaning.id]!.encounters,
      ),
    ).toBe(1)

    const noClicks = word.meanings[1]
    if (noClicks) {
      expect(afterClick.meaningStats[noClicks.id]?.clicks ?? 0).toBe(0)
    }
  })

  it('记忆 w-c：顺序模式每个含义满 REPEATS 后回注释面，且次数持久化', async () => {
    // 动态选「含义数 ≥ 2」的词：公开树默认 deck（大纲）首词可能只有 1 个含义
    const { word } = await loadWordWithMostMeanings()
    const sessionWord = {
      wordId: word.id,
      deckId: word.deckId,
      headword: word.headword,
      meanings: word.meanings.map((meaning) => ({
        meaningId: meaning.id,
        pos: meaning.pos,
        cn: meaning.cn,
      })),
      phrases: word.phrases,
    }
    const meaningCount = sessionWord.meanings.length
    const settings = {
      totalRepeats: 2,
      mode: 'sequential' as const,
      showPhrases: false,
      exampleCount: 2,
      showPhonetic: true,
    }
    let session = tapBoard(createSession({ word: sessionWord, settings }))
    session = openMemory(session)
    expect(session.stage).toBe('memory')
    expect(session.activeMeaningId).toBe(word.meanings[0]!.id)

    // 点满第一个 c 的 2 次 → needsAdvance → advance 到下一个未满 c
    session = tapMemory(tapMemory(session))
    expect(session.needsAdvance).toBe(true)
    session = advanceMemory(session)
    expect(session.stage).toBe('memory')
    // 动态断言：advance 到第 2 个含义（不再假设只有 2 个 c）
    expect(session.activeMeaningId).toBe(word.meanings[1]!.id)

    // 把剩余所有 c 点满（模拟 UI 的循环：点 → 满则 advance）
    let guard = 0
    while (session.stage === 'memory' && guard < REPEATS * meaningCount + 60) {
      session = tapMemory(session)
      if (session.needsAdvance) session = advanceMemory(session)
      guard += 1
    }
    expect(session.stage).toBe('annotation')
    expect(isMemoryComplete(session)).toBe(true)
    expect(session.wcCompletedOnce).toBe(true)
    // 每个含义都恰好满 2 次（按实际含义数，而不是写死 2 个 c）
    expect(Object.keys(session.wcCounts)).toHaveLength(meaningCount)
    for (const meaning of word.meanings) {
      expect(session.wcCounts[meaning.id] ?? 0).toBe(2)
    }

    // 快照持久化：写入后能读回（D15）
    await saveSessionSnapshot(sessionSnapshot(session))
    const snapshot = await loadSessionSnapshot(word.id)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.wcCounts).toEqual(session.wcCounts)
    await deleteSessionSnapshot(word.id)
    expect(await loadSessionSnapshot(word.id)).toBeNull()
  })

  it('中途退出记忆：快照恢复后已满的含义不再计入', async () => {
    const { word } = await loadFirstWord()
    const sessionWord = {
      wordId: word.id,
      deckId: word.deckId,
      headword: word.headword,
      meanings: word.meanings.map((meaning) => ({
        meaningId: meaning.id,
        pos: meaning.pos,
        cn: meaning.cn,
      })),
      phrases: word.phrases,
    }
    const settings = {
      totalRepeats: 3,
      mode: 'sequential' as const,
      showPhrases: false,
      exampleCount: 2,
      showPhonetic: true,
    }
    let session = openMemory(tapBoard(createSession({ word: sessionWord, settings })))
    session = tapMemory(tapMemory(session)) // 第一个 c 两次，未满
    await saveSessionSnapshot(sessionSnapshot(session))
    session = exitMemory(session)
    expect(session.stage).toBe('annotation')
    expect(session.wcCounts[word.meanings[0]!.id]).toBe(2)

    const snapshot = await loadSessionSnapshot(word.id)
    const resumed = createSession({
      word: sessionWord,
      settings,
      savedCounts: snapshot?.wcCounts ?? {},
    })
    expect(resumed.wcCounts[word.meanings[0]!.id]).toBe(2)
    // 重新进入总是从白板面开始（§4.1），进注释面后再开记忆
    const resumedMemory = openMemory(tapBoard(resumed))
    expect(resumedMemory.stage).toBe('memory')
    expect(resumedMemory.activeMeaningId).toBe(word.meanings[0]!.id)
  })

  it('记忆完成后再次点「记忆」：重开一轮（counts 归零、回到第一个 c、不重复记 encounters）', async () => {
    const { word } = await loadFirstWord()
    const sessionWord = {
      wordId: word.id,
      deckId: word.deckId,
      headword: word.headword,
      meanings: word.meanings.map((meaning) => ({
        meaningId: meaning.id,
        pos: meaning.pos,
        cn: meaning.cn,
      })),
      phrases: word.phrases,
    }
    const settings = {
      totalRepeats: 1,
      mode: 'sequential' as const,
      showPhrases: false,
      exampleCount: 2,
      showPhonetic: true,
    }
    let session = openMemory(tapBoard(createSession({ word: sessionWord, settings })))
    let guard = 0
    while (session.stage === 'memory' && guard < 40) {
      session = tapMemory(session)
      if (session.needsAdvance) session = advanceMemory(session)
      guard += 1
    }
    expect(session.stage).toBe('annotation')
    expect(isMemoryComplete(session)).toBe(true)

    // core 语义（task-17）：完成后直接再调 openMemory → 自动重置 wcCounts 重开一轮
    const restarted = openMemory(session)
    expect(restarted.stage).toBe('memory')
    expect(restarted.encountersRecorded).toBe(true) // 重开不再触发 encounters
    expect(restarted.activeMeaningId).toBe(word.meanings[0]!.id)
    for (const meaning of word.meanings) {
      expect(restarted.wcCounts[meaning.id]).toBe(0)
    }
  })

  it('random 模式（task-22）：每次点击立即重随机、needsAdvance 恒 false、最后直接回注释面', async () => {
    const { word } = await loadFirstWord()
    const sessionWord = {
      wordId: word.id,
      deckId: word.deckId,
      headword: word.headword,
      meanings: word.meanings.map((meaning) => ({
        meaningId: meaning.id,
        pos: meaning.pos,
        cn: meaning.cn,
      })),
      phrases: word.phrases,
    }
    const settings = {
      totalRepeats: 2,
      mode: 'random' as const,
      showPhrases: false,
      exampleCount: 2,
      showPhonetic: true,
    }
    const random = () => 0.42
    let session = openMemory(tapBoard(createSession({ word: sessionWord, settings })), random)
    expect(session.stage).toBe('memory')

    const totalTaps = word.meanings.length * settings.totalRepeats
    for (let i = 0; i < totalTaps; i += 1) {
      expect(session.stage).toBe('memory')
      const tapped = tapMemory(session, random)
      // random 模式不需要 advanceMemory
      expect(tapped.needsAdvance).toBe(false)
      session = tapped
    }
    // 最后一次点击后直接回注释面，且全部含义已记满
    expect(session.stage).toBe('annotation')
    expect(isMemoryComplete(session)).toBe(true)
    expect(session.wcCompletedOnce).toBe(true)
  })

  it('predictAll 官方三键文案：新词首评「今日 / N 天后」，隐藏间隔时只显示「今日」', async () => {
    const { word, wordId } = await loadFirstWord()
    const now = Date.now()
    const state = (await getState(wordId)) ?? createWordState({ wordId, deckId: word.deckId, now })
    const predicts = predictAll(state, now)
    // 新词首评：认识 progress=1 → 直接「N 天后」；模糊/忘记 progress<1 → 「今日 / N 天后」
    expect(predicts.familiar.first).toBe(true)
    expect(predicts.familiar.progress).toBe(1)
    expect(formatOfficialHint(predicts.familiar)).toBe(`${predicts.familiar.days} 天后`)
    expect(formatOfficialHint(predicts.vague)).toBe(`今日 / ${predicts.vague.days} 天后`)
    expect(formatOfficialHint(predicts.forgot)).toBe(`今日 / ${predicts.forgot.days} 天后`)
    // 设置隐藏预计复习间隔：只显示「今日」
    expect(formatOfficialHint(predicts.familiar, false)).toBe('今日')
  })

  it('评分提交：写状态/日志并返回 requeue；词条进入复习调度', async () => {
    const { wordId } = await loadFirstWord()
    const result = await submitRating(wordId, 'forgot')
    expect(result.state.lastRating).toBe('forgot')
    expect(result.longTermUpdate).toBe(true)
    expect(result.requeue).toBe('requeue-forgot')
    expect(result.state.dueAt).not.toBeNull()
    expect(result.state.nextIntervalDays).toBeGreaterThanOrEqual(1)

    const state = await getState(wordId)
    expect(state?.lastRating).toBe('forgot')
    expect(state?.phase).not.toBe('new')
    expect(state?.reps).toBe(0)
  })
})
