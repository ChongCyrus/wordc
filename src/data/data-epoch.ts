/** 0.10.0：数据 epoch——seed/import replace/clear/deleteDeck 成功后 +1；评分可用它检测会话期间数据被替换 */
import { getDb } from './db'

export const DATA_EPOCH_KEY = 'data.epoch'

export async function getDataEpoch(): Promise<number> {
  const row = await getDb().meta.get(DATA_EPOCH_KEY)
  const value = Number((row?.value as { epoch?: number } | undefined)?.epoch ?? row?.value ?? 0)
  return Number.isFinite(value) ? value : 0
}

export async function bumpDataEpoch(reason: string): Promise<number> {
  const db = getDb()
  const current = await getDataEpoch()
  const next = current + 1
  await db.meta.put({ key: DATA_EPOCH_KEY, value: { epoch: next, reason, at: Date.now() }, updatedAt: Date.now() })
  return next
}
