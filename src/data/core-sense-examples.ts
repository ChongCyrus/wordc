/** 0.3.72：本义代表 c / 本义例句（AI 预览确认后写库） */
import { getDb } from './db'
import { getEffectiveContent } from './packs.repo'
import type { CoreSenseExampleEntry, Example } from '../core'

export type { CoreSenseExampleEntry } from '../core'

export interface CoreSenseRepresentative {
  coreSenseIndex: number
  label: string
  /** 本义说明/词源（来自 effective coreSenses.note/origin，只读投影） */
  gloss?: string
  origin?: string
  /** 代表 c 的 Meaning.id（无映射/无例句时 null） */
  representativeMeaningId: string | null
  /** 代表 c 的中文（便于 UI） */
  representativeCn?: string
  examples: Array<{ en: string; cn: string }>
  phrases: Array<{ en: string; cn: string }>
}

export interface CoreSenseExampleView {
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  entry?: CoreSenseExampleEntry
  match?: 'label' | 'index'
}

export interface CoreSenseExampleViews {
  current: CoreSenseExampleView[]
  /** 对不上当前 coreSenses 的旧例句（本义已变化；可见可清） */
  stale: CoreSenseExampleEntry[]
}

function dedupeExamples(examples: Array<{ en: string; cn: string }>, max: number): Array<{ en: string; cn: string }> {
  if (max <= 0) return []
  const seen = new Set<string>()
  const out: Array<{ en: string; cn: string }> = []
  for (const example of examples) {
    const en = String(example.en ?? '').trim()
    if (!en) continue
    const cn = String(example.cn ?? '').trim()
    const key = `${en}\u0000${cn}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ en, cn })
    if (out.length >= max) break
  }
  return out
}

function toCnExamples(examples: Example[] | undefined): Array<{ en: string; cn: string }> {
  return (examples ?? []).map((example) => ({ en: example.en, cn: example.cn ?? '' }))
}

/** 按 meaningMap 顺序取第一个有例句的映射 c；例句去重；maxExamples=0 返回空 */
export async function getCoreSenseRepresentative(
  wordId: string,
  coreSenseIndex: number,
  maxExamples = 2,
): Promise<CoreSenseRepresentative | null> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return null
  const effective = await getEffectiveContent(wordId)
  const sense = effective?.coreSenses.find((item) => item.index === coreSenseIndex)
  if (!sense) return null
  const maps = (effective?.meaningMap ?? [])
    .filter((mapping) => mapping.coreSenseIndex === sense.index)
    .sort((a, b) => a.meaningIndex - b.meaningIndex)
  const meta = {
    ...(sense.note ? { gloss: sense.note } : {}),
    ...(sense.origin ? { origin: sense.origin } : {}),
  }
  if (maps.length === 0) {
    return { coreSenseIndex: sense.index, label: sense.label, ...meta, representativeMeaningId: null, examples: [], phrases: [] }
  }
  let firstMapped: { id: string; cn: string } | null = null
  let representative: { id: string; cn: string; examples: Array<{ en: string; cn: string }> } | null = null
  for (const mapping of maps) {
    const meaning = word.meanings[mapping.meaningIndex - 1]
    if (!meaning) continue
    if (!firstMapped) firstMapped = { id: meaning.id, cn: meaning.cn }
    const examples = dedupeExamples(toCnExamples(meaning.examples), Math.max(0, maxExamples))
    if (examples.length > 0) {
      representative = { id: meaning.id, cn: meaning.cn, examples }
      break
    }
  }
  // 映射 c 都没有专属例句时，回退词级例句（仍归到第一个映射 c）
  const examples = representative
    ? representative.examples
    : dedupeExamples(toCnExamples(word.examples), Math.max(0, maxExamples))
  const phraseMeaningIds = new Set(
    maps
      .map((mapping) => word.meanings[mapping.meaningIndex - 1]?.id)
      .filter((id): id is string => Boolean(id)),
  )
  // Word.phrases 按 meaningId 归属；映射 c 的专属词组优先，无则回退词级词组
  const ownPhrases = word.phrases
    .filter((phrase) => phrase.meaningId != null && phraseMeaningIds.has(phrase.meaningId))
    .map((phrase) => ({ en: phrase.en, cn: phrase.cn }))
  const wordPhrases = word.phrases
    .filter((phrase) => phrase.meaningId == null)
    .map((phrase) => ({ en: phrase.en, cn: phrase.cn }))
  const phrases = dedupeExamples(
    Math.max(0, maxExamples) === 0 ? [] : ownPhrases.length > 0 ? ownPhrases : wordPhrases,
    Math.max(0, maxExamples),
  )
  const chosen = representative ?? firstMapped
  return {
    coreSenseIndex: sense.index,
    label: sense.label,
    ...meta,
    representativeMeaningId: chosen?.id ?? null,
    ...(chosen ? { representativeCn: chosen.cn } : {}),
    examples,
    phrases,
  }
}

export async function listCoreSenseRepresentatives(
  wordId: string,
  maxExamples = 2,
): Promise<CoreSenseRepresentative[]> {
  const effective = await getEffectiveContent(wordId)
  const senses = effective?.coreSenses ?? []
  const out: CoreSenseRepresentative[] = []
  for (const sense of senses) {
    const representative = await getCoreSenseRepresentative(wordId, sense.index, maxExamples)
    if (representative) out.push(representative)
  }
  return out
}

/** 当前 coreSenses 与已存例句视图 + stale 旧条目（label 优先、index 兜底） */
export async function listCoreSenseExampleViews(wordId: string): Promise<CoreSenseExampleViews> {
  const word = await getDb().words.get(wordId)
  if (!word) return { current: [], stale: [] }
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  const entries = [...(word.coreSenseExamples ?? [])]
  const used = new Set<CoreSenseExampleEntry>()
  const matched = new Array<CoreSenseExampleEntry | null>(coreSenses.length).fill(null)
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

/** 保存（覆盖）某本义例句；AI 结果必须经 UI 预览确认后调用 */
export async function saveCoreSenseExamples(
  wordId: string,
  input: {
    coreSenseIndex: number
    label: string
    examples: Array<{ en: string; cn: string }>
    source?: 'ai' | 'manual'
  },
): Promise<CoreSenseExampleEntry | null> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  const label = String(input.label ?? '').trim()
  if (!label || !Number.isInteger(input.coreSenseIndex) || input.coreSenseIndex < 1) {
    throw new Error('本义 index/label 不合法')
  }
  const examples = dedupeExamples(input.examples, 3)
  const list = [...(word.coreSenseExamples ?? [])]
  const existingIndex = list.findIndex((entry) => entry.label === label)
  const fallback = existingIndex >= 0 ? existingIndex : list.findIndex((entry) => entry.coreSenseIndex === input.coreSenseIndex)
  if (examples.length === 0) {
    if (fallback >= 0) list.splice(fallback, 1)
    if (list.length > 0) word.coreSenseExamples = list
    else delete word.coreSenseExamples
    await getDb().words.put(word)
    return null
  }
  const entry: CoreSenseExampleEntry = {
    coreSenseIndex: input.coreSenseIndex,
    label,
    examples,
    source: input.source === 'manual' ? 'manual' : 'ai',
    updatedAt: Date.now(),
  }
  if (fallback >= 0) list[fallback] = entry
  else list.push(entry)
  word.coreSenseExamples = list
  await getDb().words.put(word)
  return entry
}

export async function clearCoreSenseExamples(
  wordId: string,
  target?: { coreSenseIndex?: number; label?: string },
): Promise<void> {
  const word = await getDb().words.get(wordId)
  if (!word) return
  if (!target) {
    if (!word.coreSenseExamples) return
    delete word.coreSenseExamples
    await getDb().words.put(word)
    return
  }
  const label = target.label?.trim()
  const next = (word.coreSenseExamples ?? []).filter(
    (entry) =>
      !(
        (label != null && entry.label === label) ||
        (label == null && target.coreSenseIndex != null && entry.coreSenseIndex === target.coreSenseIndex)
      ),
  )
  if (next.length > 0) word.coreSenseExamples = next
  else delete word.coreSenseExamples
  await getDb().words.put(word)
}
