/**
 * task-139 F6 · 用户自编辑笔记/助记（w 级 / c 级）。
 *
 * - 存 Word 本机字段 `userNotes/userMnemonics`（**不进 packItems**，AI apply/merge 不覆盖）；
 * - meaningId 缺省 = 词级（w 级），指定则为该含义（c 级，必须是 word.meanings 里的 id）；
 * - AI 助记可编辑/删除：编辑 → 保存 userMnemonics 副本 + 原 key 进 `hiddenMnemonicKeys`；
 *   删除 AI → 只加 hidden；展示合并时过滤 hidden，用户副本覆盖同 key AI。
 */
import { getDb } from './db'
import type { Meaning, Mnemonic, UserMnemonic, UserNote, Word } from '../core/types'

export type { UserMnemonic, UserNote } from '../core/types'

export interface UserNoteInput {
  id?: string
  text: string
  /** 缺省 = 词级；指定 = 含义级 */
  meaningId?: string
}

export interface UserMnemonicInput {
  id?: string
  type: UserMnemonic['type']
  text: string
  meaningId?: string
}

const USER_MNEMONIC_TYPE_SET = new Set<UserMnemonic['type']>(['联想', '谐音', '词根', '词源', '串记', '口诀', '其他'])

/** AI/用户助记稳定 key（task-139 补充：编辑/隐藏匹配用） */
export function mnemonicKey(meaningId: string | undefined, type: string, text: string): string {
  return `${meaningId ?? ''}|${type}|${text.trim()}`
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function getWordOrThrow(wordId: string): Promise<Word> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  return word
}

function normalizeMeaningId(word: Word, meaningId: string | undefined): string | undefined {
  if (!meaningId) return undefined
  if (!word.meanings.some((meaning: Meaning) => meaning.id === meaningId)) {
    throw new Error(`含义不存在：${meaningId}`)
  }
  return meaningId
}

async function saveWordFields(word: Word): Promise<void> {
  await getDb().words.put(word)
}

// ============ 笔记 ============

export async function listUserNotes(wordId: string, meaningId?: string): Promise<UserNote[]> {
  const word = await getWordOrThrow(wordId)
  const list = word.userNotes ?? []
  return meaningId === undefined ? list.filter((note) => !note.meaningId) : list.filter((note) => note.meaningId === meaningId)
}

export async function upsertUserNote(wordId: string, input: UserNoteInput): Promise<UserNote> {
  const word = await getWordOrThrow(wordId)
  const text = String(input.text ?? '').trim()
  if (!text) throw new Error('笔记内容不能为空')
  const meaningId = normalizeMeaningId(word, input.meaningId)
  const list = [...(word.userNotes ?? [])]
  const index = input.id ? list.findIndex((note) => note.id === input.id) : -1
  if (index >= 0) {
    list[index] = { ...list[index]!, text, ...(meaningId ? { meaningId } : {}) }
    if (!meaningId) delete (list[index] as UserNote).meaningId
  } else {
    list.push({ id: input.id ?? newId('un'), text, ...(meaningId ? { meaningId } : {}) })
  }
  word.userNotes = list
  await saveWordFields(word)
  return index >= 0 ? list[index]! : list[list.length - 1]!
}

export async function deleteUserNote(wordId: string, noteId: string): Promise<boolean> {
  const word = await getWordOrThrow(wordId)
  const list = word.userNotes ?? []
  const next = list.filter((note) => note.id !== noteId)
  if (next.length === list.length) return false
  if (next.length > 0) word.userNotes = next
  else delete word.userNotes
  await saveWordFields(word)
  return true
}

// ============ 助记 ============

export async function listUserMnemonics(wordId: string, meaningId?: string): Promise<UserMnemonic[]> {
  const word = await getWordOrThrow(wordId)
  const list = word.userMnemonics ?? []
  return meaningId === undefined ? list.filter((item) => !item.meaningId) : list.filter((item) => item.meaningId === meaningId)
}

export async function upsertUserMnemonic(wordId: string, input: UserMnemonicInput): Promise<UserMnemonic> {
  const word = await getWordOrThrow(wordId)
  const text = String(input.text ?? '').trim()
  if (!text) throw new Error('助记内容不能为空')
  if (!USER_MNEMONIC_TYPE_SET.has(input.type)) throw new Error(`不支持的助记类型：${input.type}`)
  const meaningId = normalizeMeaningId(word, input.meaningId)
  const list = [...(word.userMnemonics ?? [])]
  const index = input.id ? list.findIndex((item) => item.id === input.id) : -1
  if (index >= 0) {
    list[index] = { ...list[index]!, type: input.type, text, ...(meaningId ? { meaningId } : {}) }
    if (!meaningId) delete (list[index] as UserMnemonic).meaningId
  } else {
    list.push({ id: input.id ?? newId('um'), type: input.type, text, ...(meaningId ? { meaningId } : {}) })
  }
  word.userMnemonics = list
  await saveWordFields(word)
  return index >= 0 ? list[index]! : list[list.length - 1]!
}

export async function deleteUserMnemonic(wordId: string, mnemonicId: string): Promise<boolean> {
  const word = await getWordOrThrow(wordId)
  const list = word.userMnemonics ?? []
  const next = list.filter((item) => item.id !== mnemonicId)
  if (next.length === list.length) return false
  if (next.length > 0) word.userMnemonics = next
  else delete word.userMnemonics
  await saveWordFields(word)
  return true
}

// ============ AI 助记隐藏/编辑 ============

export async function hideMnemonic(wordId: string, key: string): Promise<void> {
  const word = await getWordOrThrow(wordId)
  const hidden = new Set(word.hiddenMnemonicKeys ?? [])
  hidden.add(key)
  word.hiddenMnemonicKeys = [...hidden]
  await saveWordFields(word)
}

export async function unhideMnemonic(wordId: string, key: string): Promise<void> {
  const word = await getWordOrThrow(wordId)
  const next = (word.hiddenMnemonicKeys ?? []).filter((item) => item !== key)
  if (next.length > 0) word.hiddenMnemonicKeys = next
  else delete word.hiddenMnemonicKeys
  await saveWordFields(word)
}

/** 删除 AI 助记：只记录 hidden key（AI 原数据仍在 Word.mnemonics，但展示被过滤） */
export async function deleteAiMnemonic(
  wordId: string,
  original: { meaningId?: string; type: string; text: string },
): Promise<void> {
  await hideMnemonic(wordId, mnemonicKey(original.meaningId, original.type, original.text))
}

/**
 * 编辑 AI 助记：把原 key 加入 hidden，并保存一条用户副本（默认沿用原 meaningId/type，text 可改）。
 * @returns 用户副本
 */
export async function editAiMnemonic(
  wordId: string,
  original: { meaningId?: string; type: string; text: string },
  patch: { type?: UserMnemonic['type']; text?: string; meaningId?: string },
): Promise<UserMnemonic> {
  const word = await getWordOrThrow(wordId)
  if (!word.mnemonics.some((item) => mnemonicKey(item.meaningId, item.type, item.text) === mnemonicKey(original.meaningId, original.type, original.text))) {
    throw new Error('要编辑的 AI 助记不存在')
  }
  await hideMnemonic(wordId, mnemonicKey(original.meaningId, original.type, original.text))
  return upsertUserMnemonic(wordId, {
    type: patch.type ?? (original.type as UserMnemonic['type']),
    text: patch.text ?? original.text,
    ...(patch.meaningId !== undefined ? { meaningId: patch.meaningId } : original.meaningId ? { meaningId: original.meaningId } : {}),
  })
}

export interface MergedMnemonic extends Mnemonic {
  source: 'ai' | 'user'
  /** AI 助记为稳定 key；用户助记为 user id */
  key: string
  userMnemonicId?: string
}

/**
 * 展示合并（F6）：AI 助记过滤 hidden；用户副本覆盖同 key AI；再补用户独有条目。
 * meaningId 缺省 = 词级；指定 = 该含义。
 */
export async function listMergedMnemonics(wordId: string, meaningId?: string): Promise<MergedMnemonic[]> {
  const word = await getWordOrThrow(wordId)
  const hidden = new Set(word.hiddenMnemonicKeys ?? [])
  const level = meaningId ?? undefined
  const aiList = (word.mnemonics ?? []).filter((item) => (item.meaningId ?? undefined) === level)
  const userList = (word.userMnemonics ?? []).filter((item) => (item.meaningId ?? undefined) === level)
  const userByKey = new Map(userList.map((item) => [mnemonicKey(item.meaningId, item.type, item.text), item]))
  const result: MergedMnemonic[] = []
  for (const item of aiList) {
    const key = mnemonicKey(item.meaningId, item.type, item.text)
    const userCopy = userByKey.get(key)
    if (userCopy) {
      result.push({ ...item, text: userCopy.text, type: userCopy.type, source: 'user', key, userMnemonicId: userCopy.id })
      userByKey.delete(key)
      continue
    }
    if (hidden.has(key)) continue
    result.push({ ...item, source: 'ai', key })
  }
  for (const item of userList) {
    const key = mnemonicKey(item.meaningId, item.type, item.text)
    if (result.some((entry) => entry.key === key && entry.source === 'user')) continue
    result.push({ type: item.type, text: item.text, ...(item.meaningId ? { meaningId: item.meaningId } : {}), source: 'user', key, userMnemonicId: item.id })
  }
  return result
}
