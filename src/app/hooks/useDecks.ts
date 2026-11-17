import { useLiveQuery } from 'dexie-react-hooks'
import type { Deck } from '../../core'
import { getDeck, getDeckProgress, listDecks } from '../../data'
import type { DeckProgress } from '../../data'

/** 全部词库（响应式；内置库已由 ensureBuiltinDecks 种入） */
export function useDecks() {
  const decks = useLiveQuery(() => listDecks(), [])
  return { decks: decks ?? [], loading: decks === undefined }
}

/** 单个词库 */
export function useDeck(deckId: string | null | undefined) {
  const deck = useLiveQuery(() => (deckId ? getDeck(deckId) : Promise.resolve(null)), [deckId])
  return { deck: deck ?? null, loading: deck === undefined }
}

/** 词库学习进度 */
export function useDeckProgress(deckId: string | null | undefined) {
  const progress = useLiveQuery(
    () => (deckId ? getDeckProgress(deckId) : Promise.resolve(null)),
    [deckId],
  )
  return { progress: (progress ?? null) as DeckProgress | null, loading: progress === undefined }
}

/** 词库 id → Deck 映射（列表/详情共用） */
export function useDeckMap(): { decks: Deck[]; map: Map<string, Deck>; loading: boolean } {
  const { decks, loading } = useDecks()
  const map = new Map(decks.map((deck) => [deck.id, deck]))
  return { decks, map, loading }
}

/** 词库列表 + 每个词库的学习进度（词库页一次取全） */
export function useDecksWithProgress() {
  const rows = useLiveQuery(async () => {
    const deckList = await listDecks()
    const progressList = await Promise.all(deckList.map((deck) => getDeckProgress(deck.id)))
    return deckList.map((deck, index) => ({ deck, progress: progressList[index]! }))
  }, [])
  return { rows: rows ?? [], loading: rows === undefined }
}
