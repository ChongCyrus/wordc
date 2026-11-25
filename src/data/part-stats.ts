/** 0.9.0/task-14：词根/缀不熟悉度（partStats） */
import { familiarity, type MeaningStat, type Rating } from '../core'
import { weightedTotal, type WeightedMemorySettings } from '../core/weighted-memory'
import { getDb } from './db'
import { buildInitialState } from './word-factory'
import type { RootEtymologyPart, Word, WordState } from '../core/types'
import { normalizeAffixText } from './root-affix'
import { getLearningWriteSource } from './learning-write-source'
import { sqliteQuery, sqliteTx } from './native-sqlite'
import { mapSqliteStateRow } from './sqlite-read'
import { buildStateSqliteRow } from './study-sqlite'
import { withStatsWriteLock } from './stats-write-queue'

export function partStatKey(type: string, text: string): string {
  const normalizedType = type === 'prefix' || type === 'root' || type === 'suffix' ? type : 'other'
  return `${normalizedType}:${normalizeAffixText(text)}`
}

function normalizeStat(stat: MeaningStat | undefined): MeaningStat {
  return {
    clicks: Math.max(0, Math.floor(Number(stat?.clicks) || 0)),
    encounters: Math.max(0, Math.floor(Number(stat?.encounters) || 0)),
  }
}

async function readFactState(wordId: string, now: number): Promise<{ word: Word; state: WordState; db: ReturnType<typeof getDb> }> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  if (getLearningWriteSource() === 'sqlite') {
    try {
      const response = await sqliteQuery({ table: 'states', where: { word_id: wordId }, limit: 1 }, 5_000)
      const raw = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
      return { word, state: raw ? mapSqliteStateRow(raw) : buildInitialState(word, now), db }
    } catch {
      /* 回退 IDB cache 读 */
    }
  }
  return { word, state: (await db.states.get(wordId)) ?? buildInitialState(word, now), db }
}

async function writeFactState(state: WordState): Promise<void> {
  const db = getDb()
  if (getLearningWriteSource() === 'sqlite') {
    const tx = await sqliteTx([{ op: 'upsert', table: 'states', row: buildStateSqliteRow(state) }])
    if (tx.ok === false) throw new Error(tx.message ?? 'partStats SQLite 写入失败')
    try {
      await db.states.put(state)
    } catch {
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('part-stats-cache-failed').catch(() => undefined)
    }
    return
  }
  await db.states.put(state)
}

export async function getPartStats(wordId: string): Promise<Record<string, MeaningStat>> {
  const { state } = await readFactState(wordId, Date.now())
  return { ...(state.partStats ?? {}) }
}

/** 本次展示/记忆每个 part 时 encounters += 1（同一 part 每会话只调一次） */
async function recordPartEncountersInner(
  wordId: string,
  parts: readonly Pick<RootEtymologyPart, 'type' | 'text'>[],
  now: number,
): Promise<Record<string, MeaningStat>> {
  const { state } = await readFactState(wordId, now)
  const next: Record<string, MeaningStat> = { ...(state.partStats ?? {}) }
  for (const part of parts) {
    if (!part?.text) continue
    const key = partStatKey(part.type, part.text)
    const prev = normalizeStat(next[key])
    next[key] = { clicks: prev.clicks, encounters: prev.encounters + 1 }
  }
  await writeFactState({ ...state, partStats: next, updatedAt: now })
  return next
}

/** 用户点开某个 part 含义时 clicks += 1 */
async function recordPartClickInner(
  wordId: string,
  part: Pick<RootEtymologyPart, 'type' | 'text'>,
  now: number,
): Promise<Record<string, MeaningStat>> {
  const { state } = await readFactState(wordId, now)
  const key = partStatKey(part.type, part.text)
  const next: Record<string, MeaningStat> = { ...(state.partStats ?? {}) }
  const prev = normalizeStat(next[key])
  next[key] = { clicks: prev.clicks + 1, encounters: prev.encounters }
  await writeFactState({ ...state, partStats: next, updatedAt: now })
  return next
}

export function recordPartEncounters(
  wordId: string,
  parts: readonly Pick<RootEtymologyPart, 'type' | 'text'>[],
  now = Date.now(),
): Promise<Record<string, MeaningStat>> {
  return withStatsWriteLock(wordId, () => recordPartEncountersInner(wordId, parts, now))
}

export function recordPartClick(
  wordId: string,
  part: Pick<RootEtymologyPart, 'type' | 'text'>,
  now = Date.now(),
): Promise<Record<string, MeaningStat>> {
  return withStatsWriteLock(wordId, () => recordPartClickInner(wordId, part, now))
}

/** 单 part 不熟悉度；无 encounters 默认 0 */
export async function getPartUnfamiliarity(
  wordId: string,
  part: Pick<RootEtymologyPart, 'type' | 'text'>,
): Promise<number> {
  const stats = await getPartStats(wordId)
  const stat = stats[partStatKey(part.type, part.text)]
  return familiarity(stat?.clicks ?? 0, stat?.encounters ?? 0) ?? 0
}

/** 当前词的 root parts → 加权总次数（base=普通记忆次数；高不熟→更多） */
export async function getPartTotals(
  wordId: string,
  base: number,
  settings?: WeightedMemorySettings,
): Promise<Record<string, number>> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return {}
  const { state } = await readFactState(wordId, Date.now())
  const parts = word.rootEtymology?.parts ?? []
  const stats = state?.partStats ?? {}
  const out: Record<string, number> = {}
  for (const part of parts) {
    const key = partStatKey(part.type, part.text)
    const stat = stats[key]
    const f = familiarity(stat?.clicks ?? 0, stat?.encounters ?? 0) ?? 0
    out[key] = weightedTotal(base, f, settings)
  }
  return out
}

/** 兼容预留：part 的 Rating 辅助（当前只计 clicks/encounters，不推进 DHP） */
export type PartRating = Rating
