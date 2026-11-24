/** 0.10.0/P0：学习状态检查点（states/plans/settings，不含 words，体积小、可频繁写） */
import { computeChecksum, stableStringify } from './checksum'
import { getDb } from './db'
import type { DailyPlan } from './plan.types'
import type { WordState } from '../core/types'
import type { SettingRecord } from '../core'
import type { AutoBackupBridge } from './auto-backup'

export const STATE_CHECKPOINT_FORMAT = 'momo-state-checkpoint'
export const STATE_CHECKPOINT_VERSION = 1
export const STATE_CHECKPOINT_LATEST = 'checkpoint-latest.state.json'
export const STATE_CHECKPOINT_KEEP = 3
export const STATE_CHECKPOINT_META_KEY = 'checkpoint.lastState'

export interface StateCheckpointCounts {
  states: number
  plans: number
  settings: number
}

export interface StateCheckpoint {
  format: typeof STATE_CHECKPOINT_FORMAT
  formatVersion: typeof STATE_CHECKPOINT_VERSION
  createdAt: number
  counts: StateCheckpointCounts
  states: WordState[]
  plans: DailyPlan[]
  settings: SettingRecord[]
  checksum?: string
}

export interface StateCheckpointStatus {
  state: 'idle' | 'saved' | 'failed' | 'restored'
  skipped?: boolean
  /** 0.10.0：states>0 但少于检查点时，仅提示可合并，不自动恢复 */
  mergeHint?: { availableStates: number; currentStates: number; createdAt: number }
  at?: number
  counts?: StateCheckpointCounts
  error?: string
  restored?: { states: number; plans: number; settings: number }
}

function checkpointNames(bridge: AutoBackupBridge): string[] {
  return bridge
    .list()
    .map((entry) => entry.name)
    .filter((name) => /^checkpoint-(latest|\d+)\.state\.json$/.test(name))
}

/** 删除所有检查点文件（清空数据/恢复后使用） */
export async function deleteStateCheckpointFiles(bridge: AutoBackupBridge): Promise<number> {
  let deleted = 0
  for (const name of checkpointNames(bridge)) {
    if (bridge.delete(name)) deleted += 1
  }
  return deleted
}

async function writeStatus(status: StateCheckpointStatus): Promise<void> {
  await getDb().meta.put({ key: STATE_CHECKPOINT_META_KEY, value: status, updatedAt: Date.now() })
}

export async function getStateCheckpointStatus(): Promise<StateCheckpointStatus> {
  const row = await getDb().meta.get(STATE_CHECKPOINT_META_KEY)
  return (row?.value as StateCheckpointStatus | undefined) ?? { state: 'idle' }
}

/** 生成检查点（只读 DB states/plans/settings；不含 words） */
export async function buildStateCheckpoint(now = Date.now()): Promise<{ text: string; checkpoint: StateCheckpoint }> {
  const db = getDb()
  const [states, plans, settings] = await Promise.all([
    db.states.toArray(),
    db.plans.toArray(),
    db.settings.toArray(),
  ])
  const payload = {
    format: STATE_CHECKPOINT_FORMAT,
    formatVersion: STATE_CHECKPOINT_VERSION,
    createdAt: now,
    counts: { states: states.length, plans: plans.length, settings: settings.length },
    states,
    plans,
    settings,
  } satisfies Omit<StateCheckpoint, 'checksum'>
  const checksum = await computeChecksum(stableStringify(payload))
  const checkpoint: StateCheckpoint = { ...payload, checksum: checksum.hex }
  return { text: stableStringify(checkpoint), checkpoint }
}

/** 保存检查点：latest 轮换，保留 3 份；返回状态（失败不抛） */
export async function saveStateCheckpoint(
  bridge: AutoBackupBridge,
  now = Date.now(),
): Promise<StateCheckpointStatus> {
  try {
    if (!bridge.isAvailable()) return { state: 'failed', error: '当前环境不支持检查点' }
    const { text, checkpoint } = await buildStateCheckpoint(now)
    const existing = checkpointNames(bridge).filter((name) => name !== STATE_CHECKPOINT_LATEST)
    // 旧 latest 先轮换为 checkpoint-1，其余顺延
    const names = checkpointNames(bridge)
    if (names.includes(STATE_CHECKPOINT_LATEST)) {
      const old = bridge.read(STATE_CHECKPOINT_LATEST)
      if (old) {
        for (let i = STATE_CHECKPOINT_KEEP - 1; i >= 1; i -= 1) {
          const from = `checkpoint-${i}.state.json`
          const to = `checkpoint-${i + 1}.state.json`
          const content = bridge.read(from)
          if (content) bridge.save(content, to)
        }
        bridge.save(old, 'checkpoint-1.state.json')
      }
    }
    const saved = await bridge.save(text, STATE_CHECKPOINT_LATEST)
    if (!saved.ok) {
      await writeStatus({ state: 'failed', at: now, error: saved.error ?? '保存检查点失败' })
      return { state: 'failed', at: now, error: saved.error ?? '保存检查点失败' }
    }
    // 只保留 latest + 3 份历史
    for (const name of checkpointNames(bridge)) {
      const match = name.match(/^checkpoint-(\d+)\.state\.json$/)
      if (match && Number(match[1]) > STATE_CHECKPOINT_KEEP) bridge.delete(name)
    }
    void existing
    const status: StateCheckpointStatus = { state: 'saved', at: now, counts: checkpoint.counts }
    await writeStatus(status)
    return status
  } catch (error) {
    const status: StateCheckpointStatus = {
      state: 'failed',
      at: now,
      error: error instanceof Error ? error.message : String(error),
    }
    await writeStatus(status).catch(() => undefined)
    return status
  }
}

// ---- 2s debounce + flush（评分成功后调用；失败不阻塞） ----
let checkpointTimer: ReturnType<typeof setTimeout> | null = null
let checkpointBridge: AutoBackupBridge | null = null

export function scheduleStateCheckpoint(bridge: AutoBackupBridge, delayMs = 2000): void {
  checkpointBridge = bridge
  if (checkpointTimer) clearTimeout(checkpointTimer)
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null
    const target = checkpointBridge
    if (!target) return
    void saveStateCheckpoint(target).catch(() => undefined)
  }, Math.max(0, delayMs))
}

/** 页面隐藏/退出立即 flush */
export async function flushStateCheckpoint(bridge?: AutoBackupBridge): Promise<void> {
  if (checkpointTimer) {
    clearTimeout(checkpointTimer)
    checkpointTimer = null
  }
  const target = bridge ?? checkpointBridge
  if (!target) return
  await saveStateCheckpoint(target).catch(() => undefined)
}

function parseCheckpoint(text: string): StateCheckpoint {
  const parsed = JSON.parse(text) as StateCheckpoint
  if (!parsed || parsed.format !== STATE_CHECKPOINT_FORMAT) throw new Error('不是状态检查点')
  if (parsed.formatVersion !== STATE_CHECKPOINT_VERSION) throw new Error('检查点版本不支持')
  if (!Array.isArray(parsed.states) || !Array.isArray(parsed.plans) || !Array.isArray(parsed.settings)) {
    throw new Error('检查点结构不完整')
  }
  return parsed
}

/** 启动自动恢复：仅当 states=0 且 latest 检查点有效时合并 states/plans/settings（不写 words） */
export async function restoreStateCheckpointIfEmpty(
  bridge: AutoBackupBridge,
): Promise<StateCheckpointStatus & { skipped?: boolean }> {
  try {
    if (!bridge.isAvailable()) return { state: 'idle', skipped: true }
    const { getLearningWriteSource } = await import('./learning-write-source')
    if (getLearningWriteSource() === 'sqlite') {
      const status: StateCheckpointStatus = { state: 'idle', skipped: true, error: 'SQLite 写源已启用：旧 IDB 检查点恢复已禁用，请使用 SQLite checkpoint' }
      await writeStatus(status)
      return status
    }
    const db = getDb()
    const clearedAtRow = await db.meta.get('data.clearedAt')
    const clearedAt = Number((clearedAtRow?.value as { at?: number } | undefined)?.at ?? clearedAtRow?.value ?? 0)
    const currentStates = await db.states.count()
    const candidates = [STATE_CHECKPOINT_LATEST, ...Array.from({ length: STATE_CHECKPOINT_KEEP }, (_, i) => `checkpoint-${i + 1}.state.json`)]
    let checkpoint: StateCheckpoint | null = null
    let error: string | undefined
    for (const name of candidates) {
      const text = bridge.read(name)
      if (!text) continue
      try {
        const parsed = JSON.parse(text) as StateCheckpoint
        if (parsed.format !== STATE_CHECKPOINT_FORMAT || parsed.formatVersion !== STATE_CHECKPOINT_VERSION) continue
        if (parsed.counts?.states > 0 && Array.isArray(parsed.states)) {
          checkpoint = parseCheckpoint(text)
          break
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }
    if (!checkpoint) {
      const status: StateCheckpointStatus = { state: 'idle', skipped: true, ...(error ? { error } : {}) }
      return status
    }
    if (clearedAt > 0 && checkpoint.createdAt < clearedAt) {
      // 清空数据后：旧检查点必须删除，绝不能复活
      await deleteStateCheckpointFiles(bridge)
      const status: StateCheckpointStatus = { state: 'idle', skipped: true, error: '检查点早于清空时间，已忽略' }
      await writeStatus(status)
      return status
    }
    if (currentStates > 0) {
      const available = checkpoint.counts?.states ?? checkpoint.states.length
      const status: StateCheckpointStatus = {
        state: 'idle',
        skipped: true,
        ...(available > currentStates
          ? { mergeHint: { availableStates: available, currentStates, createdAt: checkpoint.createdAt } }
          : {}),
      }
      return status
    }
    // 0.10.0：words 可能也被 IndexedDB 回收；先补内置词表再合并 states/plans
    if ((await db.words.count()) === 0) {
      const { ensureBuiltinDecks } = await import('./builtin')
      await ensureBuiltinDecks().catch(() => undefined)
    }
    if (checkpoint.checksum) {
      const checksum = await computeChecksum(
        stableStringify({
          format: checkpoint.format,
          formatVersion: checkpoint.formatVersion,
          createdAt: checkpoint.createdAt,
          counts: checkpoint.counts,
          states: checkpoint.states,
          plans: checkpoint.plans,
          settings: checkpoint.settings,
        }),
      )
      if (checksum.hex !== checkpoint.checksum) {
        const status: StateCheckpointStatus = { state: 'failed', error: '检查点 checksum 不匹配' }
        await writeStatus(status)
        return status
      }
    }
    await db.transaction('rw', db.states, db.plans, db.settings, db.meta, async () => {
      if (checkpoint.states.length > 0) await db.states.bulkPut(checkpoint.states)
      if (checkpoint.plans.length > 0) await db.plans.bulkPut(checkpoint.plans)
      for (const setting of checkpoint.settings) {
        const existing = await db.settings.get(setting.key)
        if (!existing) await db.settings.put(setting)
      }
    })
    const status: StateCheckpointStatus = {
      state: 'restored',
      at: Date.now(),
      counts: checkpoint.counts,
      restored: {
        states: checkpoint.states.length,
        plans: checkpoint.plans.length,
        settings: checkpoint.settings.length,
      },
    }
    await writeStatus(status)
    return status
  } catch (error) {
    const status: StateCheckpointStatus = {
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
    await writeStatus(status).catch(() => undefined)
    return status
  }
}



