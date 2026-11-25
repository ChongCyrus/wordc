/** 0.13：内容变更 event log（仅加速增量；日志失败不阻塞写） */
import { getDb } from './db'
import { getSettings } from './settings.repo'

export const CONTENT_EVENT_LOG_KEY = 'backup.contentEventLog'
export type ContentOpKind = 'upsert' | 'delete'
export interface ContentEventOp { seq: number; type: string; key: string; op: ContentOpKind; updatedAt: number }
export interface ContentEventLogState { lastSeq: number; dirty: boolean; lastError: string | null; updatedAt: number; ops: ContentEventOp[] }

const MAX_OPS = 500

export async function getContentEventLogState(): Promise<ContentEventLogState> {
  const row = await getDb().meta.get(CONTENT_EVENT_LOG_KEY)
  return (row?.value as ContentEventLogState | undefined) ?? { lastSeq: 0, dirty: false, lastError: null, updatedAt: 0, ops: [] }
}

export async function recordContentOp(input: { type: string; key: string; op: ContentOpKind; updatedAt?: number }): Promise<void> {
  try {
    const state = await getContentEventLogState()
    const op: ContentEventOp = { seq: state.lastSeq + 1, type: input.type, key: input.key, op: input.op, updatedAt: input.updatedAt ?? Date.now() }
    const ops = [...state.ops, op].slice(-MAX_OPS)
    const next: ContentEventLogState = { ...state, lastSeq: op.seq, ops, dirty: false, lastError: null, updatedAt: Date.now() }
    await getDb().meta.put({ key: CONTENT_EVENT_LOG_KEY, value: next, updatedAt: next.updatedAt })
  } catch (error) {
    await markContentEventLogDirty(error instanceof Error ? error.message : String(error)).catch(() => undefined)
  }
}

export async function markContentEventLogDirty(error: string): Promise<void> {
  const state = await getContentEventLogState()
  const next: ContentEventLogState = { ...state, dirty: true, lastError: error, updatedAt: Date.now() }
  await getDb().meta.put({ key: CONTENT_EVENT_LOG_KEY, value: next, updatedAt: next.updatedAt })
}

export async function listContentOpsAfter(seq: number): Promise<{ ops: ContentEventOp[]; nextSeq: number; gap: boolean }> {
  const state = await getContentEventLogState()
  const sorted = [...state.ops].sort((a, b) => a.seq - b.seq)
  const first = sorted[0]?.seq
  const gap = sorted.length > 0 && first != null && seq + 1 < first
  return { ops: sorted.filter((op) => op.seq > seq), nextSeq: state.lastSeq, gap: gap || state.dirty }
}

export async function resetContentEventLog(): Promise<void> {
  await getDb().meta.put({ key: CONTENT_EVENT_LOG_KEY, value: { lastSeq: 0, dirty: false, lastError: null, updatedAt: Date.now(), ops: [] }, updatedAt: Date.now() })
}

export async function isContentEventLogEnabled(): Promise<boolean> {
  const settings = await getSettings().catch(() => null)
  return settings?.['backup.contentEventLogEnabled'] === true
}

/** 写事务成功后调用；失败只 dirty，不抛给写入口 */
export async function recordContentOpsAfterTx(ops: Array<{ type: string; key: string; op: ContentOpKind; updatedAt?: number }>): Promise<void> {
  if (!(await isContentEventLogEnabled().catch(() => false))) return
  try {
    for (const op of ops) await recordContentOp(op)
  } catch (error) {
    await markContentEventLogDirty(error instanceof Error ? error.message : String(error)).catch(() => undefined)
  }
}
