/** 0.3.89/task-264：词详情完整注释面 / 单词语义 session 一次性读取（实时读库） */
import type {
  CoreSenseExampleEntry,
  CoreSenseOverview,
  CoreSensePhraseEntry,
  DerivationMap,
  MeaningStat,
  SenseMnemonic,
  UserMnemonic,
  UserNote,
  Word,
  WordState,
} from '../core'
import { getDb } from './db'
import { getEffectiveContent, type EffectiveContent } from './packs.repo'

export interface WordDetailBundle {
  word: Word
  state: WordState | null
  effectiveContent: EffectiveContent | null
  derivationMap: DerivationMap | null
  coreSenseOverview: CoreSenseOverview | null
  senseMnemonics: SenseMnemonic[]
  userNotes: UserNote[]
  userMnemonics: UserMnemonic[]
  coreSenseStats: Record<string, MeaningStat>
}

export interface WordSemanticSessionMeaning {
  meaningId: string
  pos?: string
  cn: string
}

export interface WordSemanticSessionWord {
  wordId: string
  deckId: string
  headword: string
  meanings: WordSemanticSessionMeaning[]
  phrases: Array<{ en: string; cn: string }>
}

export interface WordSemanticSessionData {
  word: Word
  state: WordState | null
  sessionWord: WordSemanticSessionWord
  meaningStats: Record<string, MeaningStat>
  coreSenseStats: Record<string, MeaningStat>
  /** 当前 effective 本义（index 已重编号） */
  coreSenses: EffectiveContent['coreSenses']
}

/** 一次读取词详情完整注释面所需数据；词不存在返回 null；可选项缺失返回 null/空数组 */
export async function getWordDetailBundle(wordId: string): Promise<WordDetailBundle | null> {
  const db = getDb()
  const [word, state] = await Promise.all([db.words.get(wordId), db.states.get(wordId)])
  if (!word) return null
  const effectiveContent = await getEffectiveContent(wordId).catch(() => null)
  return {
    word,
    state: state ?? null,
    effectiveContent,
    derivationMap: word.derivationMap ?? null,
    coreSenseOverview: word.coreSenseOverview ?? null,
    senseMnemonics: word.senseMnemonics ?? [],
    userNotes: word.userNotes ?? [],
    userMnemonics: word.userMnemonics ?? [],
    coreSenseStats: state?.coreSenseStats ?? {},
  }
}

/** 单词语义 session 基础数据（word/state/sessionWord/stats/effective coreSenses） */
export async function getWordSemanticSessionData(wordId: string): Promise<WordSemanticSessionData | null> {
  const db = getDb()
  const [word, state, effective] = await Promise.all([
    db.words.get(wordId),
    db.states.get(wordId),
    getEffectiveContent(wordId).catch(() => null),
  ])
  if (!word) return null
  return {
    word,
    state: state ?? null,
    sessionWord: {
      wordId: word.id,
      deckId: word.deckId,
      headword: word.headword,
      meanings: word.meanings.map((meaning) => ({
        meaningId: meaning.id,
        ...(meaning.pos ? { pos: meaning.pos } : {}),
        cn: meaning.cn,
      })),
      phrases: word.phrases.map((phrase) => ({ en: phrase.en, cn: phrase.cn })),
    },
    meaningStats: state?.meaningStats ?? {},
    coreSenseStats: state?.coreSenseStats ?? {},
    coreSenses: effective?.coreSenses ?? [],
  }
}

export type {
  CoreSenseExampleEntry,
  CoreSensePhraseEntry,
  UserNote,
  UserMnemonic,
}
