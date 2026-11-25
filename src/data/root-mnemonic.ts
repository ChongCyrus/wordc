/** 0.3.61：单词 w → 生成元 映射助记（存 Word 字段，AI apply 不覆盖）。 */
import { getDb } from './db'
import { saveWordOverlay } from './content-write-source'
import type { RootMnemonic, Word } from '../core/types'

export type { RootMnemonic } from '../core/types'

async function getWordOrThrow(wordId: string): Promise<Word> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  return word
}

export async function getRootMnemonic(wordId: string): Promise<RootMnemonic | null> {
  const word = await getWordOrThrow(wordId)
  return word.rootMnemonic ?? null
}

/** 保存/更新映射助记；source 默认 manual（AI 生成预览保存时传 'ai'） */
export async function saveRootMnemonic(
  wordId: string,
  text: string,
  source: 'manual' | 'ai' = 'manual',
): Promise<RootMnemonic> {
  const value = String(text ?? '').trim()
  if (!value) throw new Error('助记内容不能为空')
  const word = await getWordOrThrow(wordId)
  const next: RootMnemonic = { text: value, source: source === 'ai' ? 'ai' : 'manual', updatedAt: Date.now() }
  word.rootMnemonic = next
  await saveWordOverlay(word)
  return next
}

export async function clearRootMnemonic(wordId: string): Promise<boolean> {
  const word = await getWordOrThrow(wordId)
  if (!word.rootMnemonic) return false
  delete word.rootMnemonic
  await saveWordOverlay(word)
  return true
}
