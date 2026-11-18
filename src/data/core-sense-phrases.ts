/** 0.3.72：本义词组（AI 预览确认后写库；按 coreSenseIndex+label，stale 保留可见可清） */
import { getDb } from './db'
import { getEffectiveContent } from './packs.repo'
import type { CoreSensePhraseEntry } from '../core'

export type { CoreSensePhraseEntry } from '../core'

export interface CoreSensePhraseView {
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  entry?: CoreSensePhraseEntry
  match?: 'label' | 'index'
}

export interface CoreSensePhraseViews {
  current: CoreSensePhraseView[]
  stale: CoreSensePhraseEntry[]
}

function dedupePhrases(phrases: Array<{ en: string; cn: string }>, max: number): Array<{ en: string; cn: string }> {
  if (max <= 0) return []
  const seen = new Set<string>()
  const out: Array<{ en: string; cn: string }> = []
  for (const phrase of phrases) {
    const en = String(phrase.en ?? '').trim()
    if (!en) continue
    const cn = String(phrase.cn ?? '').trim()
    const key = `${en}\u0000${cn}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ en, cn })
    if (out.length >= max) break
  }
  return out
}

export async function listCoreSensePhrases(wordId: string): Promise<CoreSensePhraseEntry[]> {
  const word = await getDb().words.get(wordId)
  return word?.coreSensePhrases ?? []
}

export async function listCoreSensePhraseViews(wordId: string): Promise<CoreSensePhraseViews> {
  const word = await getDb().words.get(wordId)
  if (!word) return { current: [], stale: [] }
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  const entries = [...(word.coreSensePhrases ?? [])]
  const used = new Set<CoreSensePhraseEntry>()
  const matched = new Array<CoreSensePhraseEntry | null>(coreSenses.length).fill(null)
  const matches = new Array<'label' | 'index' | null>(coreSenses.length).fill(null)
  coreSenses.forEach((sense, index) => {
    const byLabel = entries.find((entry) => !used.has(entry) && entry.label === sense.label)
    if (byLabel) {
      used.add(byLabel)
      matched[index] = byLabel
      matches[index] = 'label'
    }
  })
  coreSenses.forEach((sense, index) => {
    if (matched[index]) return
    const byIndex = entries.find((entry) => !used.has(entry) && entry.coreSenseIndex === sense.index)
    if (byIndex) {
      used.add(byIndex)
      matched[index] = byIndex
      matches[index] = 'index'
    }
  })
  return {
    current: coreSenses.map((sense, index) => ({
      coreSenseIndex: sense.index,
      label: sense.label,
      ...(sense.note ? { gloss: sense.note } : {}),
      ...(sense.origin ? { origin: sense.origin } : {}),
      ...(matched[index] ? { entry: matched[index]! } : {}),
      ...(matches[index] ? { match: matches[index]! } : {}),
    })),
    stale: entries.filter((entry) => !used.has(entry)),
  }
}

/** 保存（覆盖）本义词组；AI 结果须经 UI 预览确认后调用；空数组=删除该条 */
export async function saveCoreSensePhrases(
  wordId: string,
  input: {
    coreSenseIndex: number
    label: string
    phrases: Array<{ en: string; cn: string }>
    source?: 'ai' | 'manual'
  },
): Promise<CoreSensePhraseEntry | null> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  const label = String(input.label ?? '').trim()
  if (!label || !Number.isInteger(input.coreSenseIndex) || input.coreSenseIndex < 1) {
    throw new Error('本义 index/label 不合法')
  }
  const phrases = dedupePhrases(input.phrases, 3)
  const list = [...(word.coreSensePhrases ?? [])]
  const existingIndex = list.findIndex((entry) => entry.label === label)
  const fallback = existingIndex >= 0 ? existingIndex : list.findIndex((entry) => entry.coreSenseIndex === input.coreSenseIndex)
  if (phrases.length === 0) {
    if (fallback >= 0) list.splice(fallback, 1)
    if (list.length > 0) word.coreSensePhrases = list
    else delete word.coreSensePhrases
    await getDb().words.put(word)
    return null
  }
  const entry: CoreSensePhraseEntry = {
    coreSenseIndex: input.coreSenseIndex,
    label,
    phrases,
    source: input.source === 'manual' ? 'manual' : 'ai',
    updatedAt: Date.now(),
  }
  if (fallback >= 0) list[fallback] = entry
  else list.push(entry)
  word.coreSensePhrases = list
  await getDb().words.put(word)
  return entry
}

export async function clearCoreSensePhrases(
  wordId: string,
  target?: { coreSenseIndex?: number; label?: string },
): Promise<void> {
  const word = await getDb().words.get(wordId)
  if (!word) return
  if (!target) {
    if (!word.coreSensePhrases) return
    delete word.coreSensePhrases
    await getDb().words.put(word)
    return
  }
  const label = target.label?.trim()
  const next = (word.coreSensePhrases ?? []).filter(
    (entry) =>
      !(
        (label != null && entry.label === label) ||
        (label == null && target.coreSenseIndex != null && entry.coreSenseIndex === target.coreSenseIndex)
      ),
  )
  if (next.length > 0) word.coreSensePhrases = next
  else delete word.coreSensePhrases
  await getDb().words.put(word)
}
