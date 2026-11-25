/**
 * 0.3.73：本义串联助记（一段话串起全部本义；AI 预览确认后写库）。
 * 0.14：写入口统一走 saveWordOverlay——sqlite 模式先写 content_kv（word-overlay），失败抛结构化错误且不回写 IDB；idb 模式行为不变。
 */
import { getDb } from './db'
import { saveWordOverlay } from './content-write-source'
import type { CoreSenseOverview } from '../core'

export type { CoreSenseOverview } from '../core'

export async function getCoreSenseOverview(wordId: string): Promise<CoreSenseOverview | null> {
  const word = await getDb().words.get(wordId)
  return word?.coreSenseOverview ?? null
}

export async function saveCoreSenseOverview(
  wordId: string,
  input: { text: string; source?: 'ai' | 'manual' },
): Promise<CoreSenseOverview> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  const text = String(input.text ?? '').trim()
  if (!text) throw new Error('串联助记不能为空')
  if (text.length > 500) throw new Error('串联助记过长（>500 字）')
  const overview: CoreSenseOverview = {
    text,
    source: input.source === 'manual' ? 'manual' : 'ai',
    updatedAt: Date.now(),
  }
  word.coreSenseOverview = overview
  await saveWordOverlay(word)
  return overview
}

export async function clearCoreSenseOverview(wordId: string): Promise<void> {
  const word = await getDb().words.get(wordId)
  if (!word?.coreSenseOverview) return
  delete word.coreSenseOverview
  await saveWordOverlay(word)
}
