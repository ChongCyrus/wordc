import { useLiveQuery } from 'dexie-react-hooks'
import { getDeckProgress, getTodayQueue } from '../../data'
import type { DeckProgress } from '../../data'
import { useDecks } from './useDecks'
import { useSettings } from './useSettings'

/**
 * 首页「今日任务仪表盘」（D19）：
 * 当前词库 + 今日队列（待复习/待新学/今日进度）+ 词库进度。
 */
export function useStudyProgress() {
  const { settings } = useSettings()
  const { decks, loading: decksLoading } = useDecks()
  const selectedDeckId = settings?.['data.selectedDeckId'] ?? ''
  const dailyGoal = settings?.['study.dailyGoal'] ?? 30

  const deckId =
    decks.find((deck) => deck.id === selectedDeckId)?.id ??
    decks.find((deck) => deck.isDefault)?.id ??
    decks[0]?.id ??
    null

  const queue = useLiveQuery(
    () => (deckId ? getTodayQueue({ deckId, dailyGoal }) : Promise.resolve(null)),
    [deckId, dailyGoal],
  )
  const progress = useLiveQuery(
    () => (deckId ? getDeckProgress(deckId) : Promise.resolve(null)),
    [deckId],
  )

  const reviewCount = queue?.reviewQueue.length ?? 0
  const newCount = queue?.newQueue.length ?? 0
  const totalPlanned = reviewCount + newCount
  const dueCount = queue?.dueCount ?? 0

  return {
    deckId,
    deck: decks.find((deck) => deck.id === deckId) ?? null,
    decks,
    loading: decksLoading || queue === undefined || progress === undefined,
    dailyGoal,
    reviewCount,
    newCount,
    totalPlanned,
    dueCount,
    progress: (progress ?? null) as DeckProgress | null,
  }
}
