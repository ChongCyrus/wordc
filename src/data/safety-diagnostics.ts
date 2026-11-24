/** 0.10.0：一键数据安全诊断包（只读 gather；写文件/下载由 app 层） */
import { getDb } from './db'
import { getDataEpoch } from './data-epoch'
import { getStateCheckpointStatus, STATE_CHECKPOINT_KEEP } from './state-checkpoint'
import type { AutoBackupBridge } from './auto-backup'
import { getRawPlanDiagnostics, type PlanDiagnostics } from './plan-diagnostics'
import { getStartupTiming, type StartupTiming } from './startup-timing'
import { getLearningWriteDiagnostics } from './learning-write-source'

export interface SafetyDiagnosticsPackage {
  format: 'momo-data-safety-diagnostics'
  formatVersion: 1
  generatedAt: number
  appVersion?: string
  dataEpoch: number
  counts: { decks: number; words: number; states: number; plans: number }
  checkpoint: unknown
  backups: Array<{ name: string; size: number; mtime: number }>
  lastWordMutation: unknown
  rawPlans?: PlanDiagnostics
  startupTiming?: StartupTiming
  learningWrite?: unknown
  startup?: StartupTiming
  diagMeta: Record<string, unknown>
  diagLogs: string[]
  storage: { usage?: number; quota?: number; persisted?: boolean; supported: boolean } | null
  errors: string[]
}

export interface GatherSafetyDiagnosticsOptions {
  bridge?: AutoBackupBridge
  appVersion?: string
  diagLogs?: readonly string[]
  errors?: readonly string[]
  now?: number
}

export const SAFETY_DIAGNOSTICS_FILE = (now = Date.now()) =>
  `data-safety-diagnostics-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`

export async function gatherDataSafetyDiagnostics(
  opts: GatherSafetyDiagnosticsOptions = {},
): Promise<SafetyDiagnosticsPackage> {
  const db = getDb()
  const [decks, words, states, plans, epoch, checkpointStatus] = await Promise.all([
    db.decks.count(),
    db.words.count(),
    db.states.count(),
    db.plans.count(),
    getDataEpoch(),
    getStateCheckpointStatus(),
  ])
  const backups = opts.bridge?.isAvailable() ? opts.bridge.list() : []
  const checkpointNames = backups
    .map((entry) => entry.name)
    .filter((name) => /^checkpoint-(latest|\d+)\.state\.json$/.test(name))
  const checkpoint = {
    status: checkpointStatus,
    latest: checkpointNames.includes('checkpoint-latest.state.json'),
    history: checkpointNames.filter((name) => name !== 'checkpoint-latest.state.json').length,
    keep: STATE_CHECKPOINT_KEEP,
  }
  const lastWordMutationRow = await db.meta.get('diag.lastWordMutation')
  const rawPlans = await getRawPlanDiagnostics().catch(() => undefined)
  const startupTiming = getStartupTiming()
  const learningWrite = await getLearningWriteDiagnostics().catch(() => null)
  const diagRows = (await db.meta.toArray()).filter((row) => row.key.startsWith('diag.'))
  const diagMeta: Record<string, unknown> = {}
  for (const row of diagRows) diagMeta[row.key] = row.value
  let storage: SafetyDiagnosticsPackage['storage'] = null
  try {
    const nav = globalThis.navigator as Navigator & { storage?: StorageManager }
    if (nav?.storage?.estimate) {
      const estimate = await nav.storage.estimate()
      const persisted = nav.storage.persisted ? await nav.storage.persisted() : undefined
      storage = {
        usage: estimate.usage,
        quota: estimate.quota,
        persisted,
        supported: true,
      }
    }
  } catch {
    storage = null
  }
  return {
    format: 'momo-data-safety-diagnostics',
    formatVersion: 1,
    generatedAt: opts.now ?? Date.now(),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    dataEpoch: epoch,
    counts: { decks, words, states, plans },
    checkpoint,
    backups: backups.map(({ name, size, mtime }) => ({ name, size, mtime })),
    lastWordMutation: lastWordMutationRow?.value ?? null,
    ...(rawPlans ? { rawPlans } : {}),
    startupTiming,
    ...(learningWrite ? { learningWrite } : {}),
    diagMeta,
    diagLogs: [...(opts.diagLogs ?? [])].slice(-20),
    storage,
    errors: [...(opts.errors ?? [])].slice(-20),
  }
}

export function serializeSafetyDiagnostics(pkg: SafetyDiagnosticsPackage): string {
  return JSON.stringify(pkg, null, 2)
}
