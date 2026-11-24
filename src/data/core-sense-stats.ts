/**
 * 0.3.70（task-211）：本义级不熟悉度统计（coreSenseStats）。
 * key 规范与 dev-algo core 一致：`JSON.stringify([label.trim(), index])`（可逆）。
 * 解析：exact → label 匹配（本义重排仍命中）→ index 兜底；孤儿 key 保留但不在当前视图/调度。
 */
import type { MeaningStat, WordState } from '../core'
import { applyMeaningClick, applyMeaningEncounter, coreSenseStatKey, resolveCoreSenseStatKey } from '../core'
import { getDb } from './db'
import { buildInitialState } from './word-factory'
import { getLearningWriteSource } from './learning-write-source'
import { sqliteQuery, sqliteTx } from './native-sqlite'
import { mapSqliteStateRow } from './sqlite-read'
import { buildStateSqliteRow } from './study-sqlite'

export type CoreSenseRef = { index: number; label: string }

export { coreSenseStatKey, resolveCoreSenseStatKey } from '../core'

async function loadOrCreateState(wordId: string, now: number): Promise<WordState> {
  const db = getDb()
  if (getLearningWriteSource() === 'sqlite') {
    try {
      const response = await sqliteQuery({ table: 'states', where: { word_id: wordId }, limit: 1 }, 5_000)
      const raw = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
      if (raw) return mapSqliteStateRow(raw)
    } catch {
      /* fallback IDB */
    }
  }
  const existing = await db.states.get(wordId)
  if (existing) return existing
  const word = await db.words.get(wordId)
  if (!word) throw new Error(`词条不存在：${wordId}`)
  return buildInitialState(word, now)
}

async function persistState(next: WordState): Promise<void> {
  const db = getDb()
  if (getLearningWriteSource() === 'sqlite') {
    const tx = await sqliteTx([{ op: 'upsert', table: 'states', row: buildStateSqliteRow(next) }])
    if (tx.ok === false) throw new Error(tx.message ?? 'coreSenseStats SQLite 写入失败')
    try {
      await db.states.put(next)
    } catch {
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('core-sense-stats-cache-failed').catch(() => undefined)
    }
    return
  }
  await db.states.put(next)
}

function validSenses(senses: CoreSenseRef[]): CoreSenseRef[] {
  const seen = new Set<string>()
  const out: CoreSenseRef[] = []
  for (const sense of senses) {
    const label = String(sense.label ?? '').trim()
    if (!label || !Number.isInteger(sense.index) || sense.index < 1) continue
    const key = coreSenseStatKey(sense.index, label)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ index: sense.index, label })
  }
  return out
}

/** 注释面点击本义：clicks += 1（可重复；与 meaningStats 独立） */
export async function recordCoreSenseClick(
  wordId: string,
  sense: CoreSenseRef,
  now: number = Date.now(),
): Promise<WordState> {
  const db = getDb()
  if (getLearningWriteSource() === 'sqlite') {
    const prev = await loadOrCreateState(wordId, now)
    const stats = { ...(prev.coreSenseStats ?? {}) }
    const key = resolveCoreSenseStatKey(stats, sense) ?? coreSenseStatKey(sense.index, sense.label.trim())
    stats[key] = applyMeaningClick(stats[key])
    const next: WordState = { ...prev, coreSenseStats: stats, updatedAt: now }
    await persistState(next)
    return next
  }
  return db.transaction('rw', db.words, db.states, async (): Promise<WordState> => {
    const prev = await loadOrCreateState(wordId, now)
    const stats = { ...(prev.coreSenseStats ?? {}) }
    const key = resolveCoreSenseStatKey(stats, sense) ?? coreSenseStatKey(sense.index, sense.label.trim())
    stats[key] = applyMeaningClick(stats[key])
    const next: WordState = { ...prev, coreSenseStats: stats, updatedAt: now }
    await db.states.put(next)
    return next
  })
}

/** 进入注释面首次展示：当前全部本义 encounters += 1（与 c encounters 同处调用） */
export async function recordCoreSenseEncounters(
  wordId: string,
  senses: CoreSenseRef[],
  now: number = Date.now(),
): Promise<WordState> {
  const db = getDb()
  const valid = validSenses(senses)
  if (getLearningWriteSource() === 'sqlite') {
    const prev = await loadOrCreateState(wordId, now)
    const stats = { ...(prev.coreSenseStats ?? {}) }
    for (const sense of valid) {
      const key = resolveCoreSenseStatKey(stats, sense) ?? coreSenseStatKey(sense.index, sense.label)
      stats[key] = applyMeaningEncounter(stats[key])
    }
    const next: WordState = { ...prev, coreSenseStats: stats, updatedAt: now }
    await persistState(next)
    return next
  }
  return db.transaction('rw', db.words, db.states, async (): Promise<WordState> => {
    const prev = await loadOrCreateState(wordId, now)
    const stats = { ...(prev.coreSenseStats ?? {}) }
    for (const sense of valid) {
      const key = resolveCoreSenseStatKey(stats, sense) ?? coreSenseStatKey(sense.index, sense.label)
      stats[key] = applyMeaningEncounter(stats[key])
    }
    const next: WordState = { ...prev, coreSenseStats: stats, updatedAt: now }
    await db.states.put(next)
    return next
  })
}

/** 读取某词 coreSenseStats（缺失返回 {}） */
export async function getCoreSenseStats(wordId: string): Promise<Record<string, MeaningStat>> {
  const state = await loadOrCreateState(wordId, Date.now())
  return state.coreSenseStats ?? {}
}
