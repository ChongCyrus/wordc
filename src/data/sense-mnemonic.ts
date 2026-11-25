/**
 * 0.3.65：本义（coreSenses）助记——「w → 该本义」。
 * 存 Word.senseMnemonics，按 coreSenseIndex+label；manual 不被 AI 自动覆盖。
 * 匹配：优先 label（当前 coreSenses 唯一 label），找不到再按 index 兜底；对不上的旧条目为 stale（不静默隐藏）。
 */
import { getDb } from './db'
import { saveWordOverlay } from './content-write-source'
import { getSettings } from './settings.repo'
import { getEffectiveContent } from './packs.repo'
import { getTodayPlan } from './plans.repo'
import type { SenseMnemonic, Word } from '../core/types'

export type { SenseMnemonic } from '../core/types'

export interface SenseMnemonicInput {
  coreSenseIndex: number
  label: string
  text: string
  source?: 'manual' | 'ai'
}

export interface SenseMnemonicView {
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  mnemonic?: SenseMnemonic
  /** label 优先匹配 / index 兜底匹配 */
  match?: 'label' | 'index'
}

export interface SenseMnemonicViews {
  current: SenseMnemonicView[]
  /** 对不上当前 coreSenses 的旧助记（UI 显示「本义已变化：旧助记…」） */
  stale: SenseMnemonic[]
}

export interface SenseMnemonicSuggestion {
  coreSenseIndex: number
  label: string
  text: string
}

export interface SenseMnemonicApplyResult {
  applied: number
  /** 已有 manual 助记，跳过 */
  skippedManual: number
  /** 已有 AI 助记且未要求覆盖 */
  skippedExisting: number
  /** 建议对应的本义已不存在（本义被替换/删除） */
  stale: number
}

export interface SenseMnemonicSource {
  wordId: string
  word: string
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  meanings: Array<{ index: number; cn: string; pos?: string }>
  existing?: SenseMnemonic
  /** 0.3.70：该本义已标不常考（仅 includeRare=true 时可能返回） */
  rare?: true
}

export type SenseMnemonicScope =
  | { scope: 'word'; wordId: string }
  | { scope: 'today' }
  | { scope: 'deck'; deckId?: string }

async function getWordOrThrow(wordId: string): Promise<Word> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  return word
}

function cleanInput(input: SenseMnemonicInput): SenseMnemonicInput {
  const label = String(input.label ?? '').trim()
  const text = String(input.text ?? '').trim()
  if (!label) throw new Error('本义 label 不能为空')
  if (!text) throw new Error('助记内容不能为空')
  if (!Number.isInteger(input.coreSenseIndex) || input.coreSenseIndex < 1) throw new Error('coreSenseIndex 必须 ≥1')
  return { coreSenseIndex: input.coreSenseIndex, label, text, ...(input.source ? { source: input.source } : {}) }
}

/** 原始读取（含 stale；按存储顺序） */
export async function listSenseMnemonics(wordId: string): Promise<SenseMnemonic[]> {
  const word = await getWordOrThrow(wordId)
  return word.senseMnemonics ?? []
}

/** 当前 coreSenses 与助记匹配视图 + stale 旧条目（UI 用） */
export async function listSenseMnemonicViews(wordId: string): Promise<SenseMnemonicViews> {
  const word = await getWordOrThrow(wordId)
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  const entries = [...(word.senseMnemonics ?? [])]
  const used = new Set<SenseMnemonic>()
  const current: SenseMnemonicView[] = coreSenses.map((sense) => {
    const byLabel = entries.find((entry) => !used.has(entry) && entry.label === sense.label)
    const matched = byLabel ?? entries.find((entry) => !used.has(entry) && entry.coreSenseIndex === sense.index)
    if (matched) used.add(matched)
    return {
      coreSenseIndex: sense.index,
      label: sense.label,
      ...(sense.note ? { gloss: sense.note } : {}),
      ...(sense.origin ? { origin: sense.origin } : {}),
      ...(matched ? { mnemonic: matched } : {}),
      ...(matched ? { match: byLabel ? 'label' : 'index' } : {}),
    }
  })
  return { current, stale: entries.filter((entry) => !used.has(entry)) }
}

/** 保存/更新单条本义助记（label 优先/index 兜底匹配；source 默认 manual） */
export async function saveSenseMnemonic(wordId: string, input: SenseMnemonicInput): Promise<SenseMnemonic> {
  const clean = cleanInput(input)
  const word = await getWordOrThrow(wordId)
  const list = [...(word.senseMnemonics ?? [])]
  const index = list.findIndex((entry) => entry.label === clean.label)
  const fallback = index >= 0 ? index : list.findIndex((entry) => entry.coreSenseIndex === clean.coreSenseIndex)
  const next: SenseMnemonic = {
    coreSenseIndex: clean.coreSenseIndex,
    label: clean.label,
    text: clean.text,
    source: clean.source === 'ai' ? 'ai' : 'manual',
    updatedAt: Date.now(),
  }
  if (fallback >= 0) list[fallback] = next
  else list.push(next)
  word.senseMnemonics = list
  await saveWordOverlay(word)
  return next
}

export async function clearSenseMnemonic(
  wordId: string,
  target: { coreSenseIndex?: number; label?: string },
): Promise<boolean> {
  const word = await getWordOrThrow(wordId)
  const before = word.senseMnemonics ?? []
  const next = before.filter(
    (entry) =>
      !(
        (target.label != null && entry.label === target.label.trim()) ||
        (target.label == null && target.coreSenseIndex != null && entry.coreSenseIndex === target.coreSenseIndex)
      ),
  )
  if (next.length === before.length) return false
  if (next.length > 0) word.senseMnemonics = next
  else delete word.senseMnemonics
  await saveWordOverlay(word)
  return true
}

export async function clearAllSenseMnemonics(wordId: string): Promise<void> {
  const word = await getWordOrThrow(wordId)
  if (!word.senseMnemonics) return
  delete word.senseMnemonics
  await saveWordOverlay(word)
}

/**
 * 应用 AI 建议：只覆盖 AI 已有（overwriteAi=true）；manual 永不自动覆盖；
 * 对不上当前 coreSenses 的建议计入 stale。
 */
export async function applySenseMnemonicSuggestions(
  wordId: string,
  suggestions: SenseMnemonicSuggestion[],
  opts: { overwriteAi?: boolean } = {},
): Promise<SenseMnemonicApplyResult> {
  const word = await getWordOrThrow(wordId)
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  const list = [...(word.senseMnemonics ?? [])]
  const result: SenseMnemonicApplyResult = { applied: 0, skippedManual: 0, skippedExisting: 0, stale: 0 }
  const seen = new Set<string>()
  for (const suggestion of suggestions) {
    const label = String(suggestion.label ?? '').trim()
    const text = String(suggestion.text ?? '').trim()
    const key = `${suggestion.coreSenseIndex}|${label}`
    if (!label || !text || seen.has(key)) continue
    seen.add(key)
    const current =
      coreSenses.find((sense) => sense.label === label) ??
      coreSenses.find((sense) => sense.index === suggestion.coreSenseIndex)
    if (!current) {
      result.stale += 1
      continue
    }
    const existingIndex = list.findIndex((entry) => entry.label === current.label)
    const fallback = existingIndex >= 0 ? existingIndex : list.findIndex((entry) => entry.coreSenseIndex === current.index)
    const existing = fallback >= 0 ? list[fallback] : undefined
    if (existing?.source === 'manual') {
      result.skippedManual += 1
      continue
    }
    if (existing?.source === 'ai' && !opts.overwriteAi) {
      result.skippedExisting += 1
      continue
    }
    const next: SenseMnemonic = {
      coreSenseIndex: current.index,
      label: current.label,
      text,
      source: 'ai',
      updatedAt: Date.now(),
    }
    if (fallback >= 0) list[fallback] = next
    else list.push(next)
    result.applied += 1
  }
  if (result.applied > 0) {
    word.senseMnemonics = list
    await saveWordOverlay(word)
  }
  return result
}

/** 批量候选：当前词/今日/当前词库（≤200 词），只取有 coreSenses 的词 */
export async function collectSenseMnemonicSources(
  scope: SenseMnemonicScope,
  opts: { limit?: number; includeExisting?: boolean; includeRare?: boolean } = {},
): Promise<SenseMnemonicSource[]> {
  const db = getDb()
  const maxWords = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 200)))
  let wordIds: string[]
  if (scope.scope === 'word') {
    wordIds = [scope.wordId]
  } else if (scope.scope === 'today') {
    wordIds = (await getTodayPlan()).wordIds
  } else {
    const deckId = scope.deckId ?? (await getSettings())['data.selectedDeckId']
    if (!deckId) return []
    wordIds = (await db.words.where('deckId').equals(deckId).toArray())
      .sort((a, b) => a.order - b.order)
      .map((word) => word.id)
  }
  const sources: SenseMnemonicSource[] = []
  const visited = new Set<string>()
  for (const wordId of wordIds) {
    if (visited.has(wordId)) continue
    visited.add(wordId)
    if (visited.size > maxWords) break
    const word = await db.words.get(wordId)
    if (!word) continue
    const effective = await getEffectiveContent(wordId)
    const coreSenses = effective?.coreSenses ?? []
    if (coreSenses.length === 0) continue
    const stored = word.senseMnemonics ?? []
    const rareEntries = word.rareCoreSenses ?? []
    const meanings = word.meanings.map((meaning, index) => ({
      index: index + 1,
      cn: meaning.cn,
      ...(meaning.pos ? { pos: meaning.pos } : {}),
    }))
    for (const sense of coreSenses) {
      const existing =
        stored.find((entry) => entry.label === sense.label) ??
        stored.find((entry) => entry.coreSenseIndex === sense.index)
      if (existing && !opts.includeExisting) continue
      // rare：label 优先、index 兜底；stale 旧标记不误伤当前本义
      const rareByLabel = rareEntries.some((entry) => entry.label === sense.label)
      const rare = rareByLabel || (!rareByLabel && rareEntries.some((entry) => entry.coreSenseIndex === sense.index))
      if (rare && !opts.includeRare) continue
      sources.push({
        wordId: word.id,
        word: word.headword,
        coreSenseIndex: sense.index,
        label: sense.label,
        ...(sense.note ? { gloss: sense.note } : {}),
        ...(sense.origin ? { origin: sense.origin } : {}),
        meanings,
        ...(existing ? { existing } : {}),
        ...(rare ? { rare: true } : {}),
      })
    }
    if (visited.size >= maxWords) break
  }
  return sources
}
