/** 0.12 A：内容备份稳定 API（供 dev-ui；所有失败结构化返回，不抛） */
import {
  buildContentSnapshot,
  buildContentIncrement,
  diffContentEntries,
  exportContentEntities,
  saveContentBaselineChunked,
  restoreContentBaselineIndexed,
  saveContentIncrementFile,
  restoreContentBaseline,
  restoreContentIncrementChain,
  getContentChainState,
  setContentChainState,
  markContentChainFailure,
  markContentChainSuccess,
  type ContentBackupStorage,
  type ContentBaselineFile,
  type ContentIncrementPackage,
} from './content-snapshot'
import { getDb } from './db'
import { withDataWriteLock } from './write-lock'
import { fnv1a64Hex } from './checksum'
import { hashContentValue } from './content-snapshot'
import { getContentEventLogState, isContentEventLogEnabled, listContentOpsAfter } from './content-event-log'
import { getSettings } from './settings.repo'

let storage: ContentBackupStorage | null = null
let contentAutoRunning = false

function notifyContentBackupUpdated(detail: { mode: 'baseline' | 'increment' | 'error'; revision?: number; error?: string; status?: ContentBackupStatus }): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('momo:content-backup-updated', { detail }))
  } catch { /* ignore */ }
}
export function setContentBackupStorage(next: ContentBackupStorage | null): void { storage = next }
function requireStorage(): ContentBackupStorage | { error: string } {
  return storage ?? { error: '内容备份存储未初始化（需先 setContentBackupStorage(createContentBackupStorage())）' }
}

export interface ContentBackupStatus {
  enabled: boolean
  lastBaseline: number | null
  lastIncrement: number | null
  lastSuccess: number | null
  consecutiveFailures: number
  needsFullSnapshot: boolean
  chainBroken: boolean
  error?: string
}

export interface ContentBackupListItem {
  id: string
  name: string
  kind: 'baseline' | 'increment'
  revision: number
  sequence: number
  size: number
  mtime: number
  valid: boolean
  checksum: string
  parentChecksum?: string
}

const LAST_BASELINE_META = 'backup.contentLastBaseline'
const LAST_INCREMENT_META = 'backup.contentLastIncrement'

function parseFile(name: string): { kind: 'baseline' | 'increment'; revision: number } | null {
  const base = /^content-baseline-(\d+)-/.exec(name)
  if (base) return { kind: 'baseline', revision: Number(base[1]) }
  const inc = /^content-increment-(\d+)-/.exec(name)
  if (inc) return { kind: 'increment', revision: Number(inc[1]) }
  return null
}

async function createContentBaselineInner(): Promise<{ ok: boolean; revision: number; snapshotId: string; counts: Record<string, number>; bytes: number; error?: string }> {
  const target = requireStorage(); if ('error' in target) return { ok: false, revision: 0, snapshotId: '', counts: {}, bytes: 0, error: target.error }
  try {
    const chain = await getContentChainState()
    const snapshot = await buildContentSnapshot({ revision: (chain?.revision ?? 0) + 1 })
    const saved = await saveContentBaselineChunked(target, snapshot)
    if (!saved.ok || !saved.indexName) throw new Error(saved.error ?? '基线保存失败')
    const result = await markContentChainSuccess({ baseSnapshotId: snapshot.snapshotId, revision: snapshot.revision, sequence: 0 })
    await getDb().meta.put({ key: LAST_BASELINE_META, value: { at: Date.now(), id: saved.indexName, revision: snapshot.revision }, updatedAt: Date.now() })
    await getDb().meta.put({ key: 'backup.contentChain', value: { ...result, lastLogSeq: (await getContentEventLogState()).lastSeq }, updatedAt: Date.now() })
    notifyContentBackupUpdated({ mode: 'baseline', revision: snapshot.revision, status: await getContentBackupStatus() })
    return { ok: true, revision: snapshot.revision, snapshotId: snapshot.snapshotId, counts: snapshot.counts, bytes: saved.bytes }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markContentChainFailure('baseline-failed').catch(() => undefined)
    notifyContentBackupUpdated({ mode: 'error', error: message, status: await getContentBackupStatus() })
    return { ok: false, revision: 0, snapshotId: '', counts: {}, bytes: 0, error: message }
  }
}

/** P1：备份/增量与内容写入互斥，避免 manifest/实体两次读不一致 */
export function createContentBaseline(): Promise<{ ok: boolean; revision: number; snapshotId: string; counts: Record<string, number>; bytes: number; error?: string }> {
  return createContentBaselineInner()
}

export function createContentIncrement(): Promise<{ ok: boolean; mode: 'increment' | 'noop' | 'full-required'; revision: number; sequence: number; items: number; tombstones: number; error?: string }> {
  return createContentIncrementInner()
}

async function runContentStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    const result = await Promise.race([fn(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stage ${name} 超时`)), 20_000))])
    const ms = Date.now() - started
    try { console.info('[content-backup] stage', name, ms) } catch { /* ignore */ }
    return result
  } catch (error) {
    try { console.info('[content-backup] stage-fail', name, Date.now() - started, error instanceof Error ? error.message : String(error)) } catch { /* ignore */ }
    throw error
  }
}

async function createContentIncrementInner(): Promise<{ ok: boolean; mode: 'increment' | 'noop' | 'full-required'; revision: number; sequence: number; items: number; tombstones: number; error?: string }> {
  const target = requireStorage(); if ('error' in target) return { ok: false, mode: 'full-required', revision: 0, sequence: 0, items: 0, tombstones: 0, error: target.error }
  try {
    const chain = await getContentChainState()
    if (!chain || chain.needsFullSnapshot) return { ok: false, mode: 'full-required', revision: chain?.revision ?? 0, sequence: chain?.sequence ?? 0, items: 0, tombstones: 0, error: '需要新完整基线' }
    const baseId = (await getDb().meta.get(LAST_BASELINE_META))?.value as { id?: string } | undefined
    const baseText = baseId?.id ? target.read(baseId.id) : null
    if (!baseText) return { ok: false, mode: 'full-required', revision: chain.revision, sequence: chain.sequence, items: 0, tombstones: 0, error: '基线文件缺失' }
    const baseFile = JSON.parse(baseText) as ContentBaselineFile
    if ((baseFile.manifest.entitySetVersion ?? 0) !== 1) {
      return { ok: false, mode: 'full-required', revision: chain.revision, sequence: chain.sequence, items: 0, tombstones: 0, error: '基线格式/实体口径过旧（entitySetVersion 不匹配），请重建完整基线' }
    }
    const current = await runContentStage('snapshot', () => buildContentSnapshot({ revision: chain.revision }))
    const delta = await runContentStage('delta', async () => diffContentEntries(baseFile.manifest.entries, current.entries))
    try { console.info('[content-backup] counts', { currentEntries: current.entries.length, deltaEntities: delta.entities.length, tombstones: delta.tombstones.length }) } catch { /* ignore */ }
    if (delta.entities.length > 500 && delta.entities.length > current.entries.length * 0.2) {
      return { ok: false, mode: 'full-required', revision: chain.revision, sequence: chain.sequence, items: 0, tombstones: 0, error: `delta 过大（${delta.entities.length}/${current.entries.length}），基线过旧或口径不一致，请重建完整基线` }
    }
    const changed = await runContentStage('exportChanged', () => exportContentEntities(delta.entities))
    const pkgOr = await runContentStage('buildPkg', async () => buildContentIncrement(baseFile.manifest, current, { entities: changed.map(({ type, key, data }) => ({ type, key, data })) }))
    if ('needsFullSnapshot' in pkgOr) return { ok: false, mode: 'full-required', revision: chain.revision, sequence: chain.sequence, items: 0, tombstones: 0, error: pkgOr.reason }
    let source: 'log' | 'diff' = 'diff'
    try {
      if (await isContentEventLogEnabled()) {
        const logBefore = await listContentOpsAfter(chain.lastLogSeq ?? 0)
        if (!logBefore.gap) {
          const map = new Map(current.entries.map((entry) => [`${entry.type}|${entry.key}`, entry.hash]))
          const hashOk = logBefore.ops.every((op) => op.op === 'delete' ? !map.has(`${op.type}|${op.key}`) : map.get(`${op.type}|${op.key}`) != null)
          if (hashOk && logBefore.ops.length > 0) source = 'log'
        }
      }
    } catch { source = 'diff' }
    pkgOr.source = source
    const saved = await runContentStage('saveFile', () => saveContentIncrementFile(target, pkgOr))
    if (!saved.ok) throw new Error(saved.error ?? '增量保存失败')
    let logSeq = chain.lastLogSeq
    if (source === 'log') logSeq = (await getContentEventLogState()).lastSeq
    const next = await runContentStage('chainMeta', async () => setContentChainState({ ...chain, revision: pkgOr.newRevision, sequence: chain.sequence + 1, needsFullSnapshot: false, consecutiveFailures: 0, ...(logSeq != null ? { lastLogSeq: logSeq } : {}), updatedAt: Date.now() }))
    await getDb().meta.put({ key: LAST_INCREMENT_META, value: { at: Date.now(), id: saved.name, revision: next.revision, sequence: next.sequence }, updatedAt: Date.now() })
    await runContentStage('notify', async () => notifyContentBackupUpdated({ mode: 'increment', revision: next.revision, status: await getContentBackupStatus() }))
    try { console.info('[content-backup] pkg', { items: pkgOr.entities.length, tombstones: pkgOr.tombstones.length, source, bytes: saved.name ? (target.read(saved.name)?.length ?? 0) : 0 }) } catch { /* ignore */ }
    return { ok: true, mode: 'increment', revision: next.revision, sequence: next.sequence, items: pkgOr.entities.length, tombstones: pkgOr.tombstones.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await getDb().meta.put({ key: 'backup.contentIncrement.diag', value: { at: Date.now(), error: message }, updatedAt: Date.now() }).catch(() => undefined)
    await markContentChainFailure('increment-failed').catch(() => undefined)
    notifyContentBackupUpdated({ mode: 'error', error: message, status: await getContentBackupStatus() })
    return { ok: false, mode: 'full-required', revision: 0, sequence: 0, items: 0, tombstones: 0, error: message }
  }
}

export async function listContentBackups(): Promise<ContentBackupListItem[]> {
  const target = requireStorage(); if ('error' in target) return []
  const items: ContentBackupListItem[] = []
  const checksumBySnapshot = new Map<string, string>()
  const raw: Array<{ id: string; kind: 'baseline' | 'increment'; revision: number; size: number; mtime: number; valid: boolean; checksum: string; baseSnapshotId?: string; snapshotId?: string }> = []
  for (const file of target.list()) {
    if (/-part-\d+\.json(\.gz)?$/.test(file.name)) continue
    const parsed = parseFile(file.name)
    if (!parsed) continue
    const text = target.read(file.name)
    let valid = false; let checksum = ''; let baseSnapshotId: string | undefined; let snapshotId: string | undefined
    try {
      const object = JSON.parse(String(text)) as { checksum?: string; baseSnapshotId?: string; snapshotId?: string; format?: string; manifest?: { snapshotId?: string } }
      valid = parsed.kind === 'baseline' ? object.format === 'momo-content-baseline' || object.format === 'momo-content-baseline-index' : object.format === 'momo-content-increment'
      checksum = typeof object.checksum === 'string' && object.checksum.length > 'fnv1a64:'.length ? object.checksum : `fnv1a64:${fnv1a64Hex(String(text))}`
      baseSnapshotId = object.baseSnapshotId
      snapshotId = parsed.kind === 'baseline' ? object.manifest?.snapshotId : object.snapshotId
      if (snapshotId) checksumBySnapshot.set(snapshotId, checksum)
    } catch { valid = false }
    raw.push({ id: file.name, kind: parsed.kind, revision: parsed.revision, size: file.size, mtime: file.mtime, valid, checksum, ...(baseSnapshotId ? { baseSnapshotId } : {}), ...(snapshotId ? { snapshotId } : {}) })
  }
  for (const entry of raw) {
    const parentChecksum = entry.baseSnapshotId ? checksumBySnapshot.get(entry.baseSnapshotId) : undefined
    items.push({ id: entry.id, name: entry.id, kind: entry.kind, revision: entry.revision, sequence: 0, size: entry.size, mtime: entry.mtime, valid: entry.valid, checksum: entry.checksum.replace(/^fnv1a64:/, ''), ...(parentChecksum ? { parentChecksum: parentChecksum.replace(/^fnv1a64:/, '') } : {}) })
  }
  return items.sort((a, b) => b.mtime - a.mtime)
}

export interface RestoreContentBackupOptions {
  /** 既有参数；恢复入口本身尚未接线 preBackup（保持 0.12 行为） */
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  /** 调用方已持 withDataWriteLock 时传 true，避免嵌套死锁（A8） */
  skipWriteLock?: boolean
}

/**
 * 0.15：native content runtime 判定。
 * 优先 task-293 的 `isNativeContentSqliteRuntime`（导出后自动生效）；未合入时用 MomoBridge 兜底。
 */
async function isNativeContentRuntime(): Promise<boolean> {
  try {
    const module = (await import('./content-write-source')) as unknown as Record<string, unknown>
    const helper = module.isNativeContentSqliteRuntime
    if (typeof helper === 'function') return Boolean((helper as () => boolean)())
  } catch {
    // 继续用兜底判定
  }
  try {
    const bridge = (globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge
    return bridge?.isNativeApp?.() === 'momo-apk'
  } catch {
    return false
  }
}

/**
 * 0.15：native 单一事实源下，恢复前必须已有 sqlite 事实源。
 * v15 迁移未完成/失败（source=idb）时 fail-closed 拒绝内容恢复（E_CONTENT_SOURCE_NOT_SQLITE），
 * 不允许把 IDB cache 当事实源回退（否则 native 双源）。Web（非 native）仍按 IDB 恢复。
 */
async function contentRestoreSourceGate(): Promise<string | null> {
  try {
    if (!(await isNativeContentRuntime())) return null
    const { getContentWriteSource } = await import('./content-write-source')
    if ((await getContentWriteSource()) === 'sqlite') return null
    return 'E_CONTENT_SOURCE_NOT_SQLITE: native 内容事实源尚未就绪（v15 迁移未完成或失败），拒绝用 IDB cache 恢复内容；请先完成 0.15 迁移'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A8：恢复入口统一持全局写锁，避免与评分/导入等破坏性写交错；内部恢复传 skipWriteLock 不再上锁 */
export async function restoreContentBackup(id: string, opts: RestoreContentBackupOptions = {}): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
  const run = () => restoreContentBackupInner(id)
  return opts.skipWriteLock === true ? run() : withDataWriteLock(run)
}

async function restoreContentBackupInner(id: string): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
  const target = requireStorage(); if ('error' in target) return { ok: false, counts: {}, error: target.error }
  const { markIdbCacheDirty, getIdbCacheMeta, clearIdbCacheDirty } = await import('./idb-cache')
  const cacheMetaBefore = await getIdbCacheMeta().catch(() => null)
  // P1-4：整库内容恢复不是单事务；先打 journal+dirty，kill 后不会把半替换 cache 当干净
  await markIdbCacheDirty('content-restore-in-progress').catch(() => undefined)
  await getDb().meta.put({ key: 'content.restore.stageNow', value: { id, at: Date.now() }, updatedAt: Date.now() }).catch(() => undefined)
  const finish = async (result: { ok: boolean; counts: Record<string, number>; error?: string }) => {
    if (result.ok) {
      await getDb().meta.delete('content.restore.stageNow').catch(() => undefined)
      await getDb().meta.delete('content.restore.interrupted').catch(() => undefined)
      await clearIdbCacheDirty(cacheMetaBefore ?? { generation: 0, sqliteUserVersion: 3, dirty: false }).catch(() => undefined)
    } else {
      await getDb().meta.put({ key: 'content.restore.stageNow', value: { id, at: Date.now(), error: result.error ?? null }, updatedAt: Date.now() }).catch(() => undefined)
    }
    return result
  }
  try {
    type Item = { id: string; text: string; parsed: ContentBaselineFile | ContentIncrementPackage }
    const items: Item[] = []
    for (const file of target.list()) {
      const text = target.read(file.name)
      if (!text) continue
      try {
        const parsed = JSON.parse(text) as ContentBaselineFile | ContentIncrementPackage
        if ((parsed as { format?: string }).format === 'momo-content-baseline' || (parsed as { format?: string }).format === 'momo-content-baseline-index' || parsed.format === 'momo-content-increment') items.push({ id: file.name, text, parsed })
      } catch { /* bad file */ }
    }
    const targetItem = items.find((item) => item.id === id)
    if (!targetItem) return { ok: false, counts: {}, error: '备份文件不存在' }
    // 0.15：native 下只认 SQLite 事实源；v15 未就绪时拒绝用 IDB cache 恢复
    const sourceError = await contentRestoreSourceGate()
    if (sourceError) return { ok: false, counts: {}, error: sourceError }
    if (targetItem.parsed.format === 'momo-content-baseline') {
      const result = await restoreContentBaseline(targetItem.parsed, { skipWriteLock: true })
      if (result.ok) {
        await getDb().meta.put({ key: LAST_BASELINE_META, value: { at: Date.now(), id: targetItem.id, revision: targetItem.parsed.manifest.revision }, updatedAt: Date.now() })
      }
      return finish(result)
    }
    if ((targetItem.parsed as unknown as { format: string }).format === 'momo-content-baseline-index') {
      const result = await restoreContentBaselineIndexed(target, targetItem.id, { skipWriteLock: true })
      if (result.ok) {
        const index = targetItem.parsed as unknown as { manifest?: { revision?: number } }
        await getDb().meta.put({ key: LAST_BASELINE_META, value: { at: Date.now(), id: targetItem.id, revision: index.manifest?.revision ?? 0 }, updatedAt: Date.now() })
      }
      return finish(result)
    }
    // 增量：沿 baseSnapshotId 找祖先，直到 baseline
    const bySnapshot = new Map<string, Item>()
    for (const item of items) {
      const snapshotId = item.parsed.format === 'momo-content-baseline' ? item.parsed.manifest.snapshotId : (item.parsed as unknown as { format: string; snapshotId?: string; manifest?: { snapshotId?: string } }).format === 'momo-content-baseline-index' ? (item.parsed as unknown as { manifest: { snapshotId: string } }).manifest.snapshotId : item.parsed.snapshotId
      bySnapshot.set(snapshotId, item)
    }
    const chain: ContentIncrementPackage[] = []
    let cursor: Item | undefined = targetItem
    const seen = new Set<string>()
    while (cursor && cursor.parsed.format === 'momo-content-increment') {
      if (seen.has(cursor.id)) return { ok: false, counts: {}, error: '增量链存在环' }
      seen.add(cursor.id)
      chain.unshift(cursor.parsed)
      cursor = bySnapshot.get(cursor.parsed.baseSnapshotId)
    }
    if (!cursor) return { ok: false, counts: {}, error: '缺少祖先基线或链断' }
    let baseFile: ContentBaselineFile
    if (cursor.parsed.format === 'momo-content-baseline') baseFile = cursor.parsed
    else if ((cursor.parsed as unknown as { format: string }).format === 'momo-content-baseline-index') {
      const index = cursor.parsed as unknown as { manifest: ContentBaselineFile['manifest']; chunks: Array<{ name: string; count: number; checksum: string }> }
      const entities: ContentBaselineFile['entities'] = []
      for (const ref of index.chunks) {
        const text = target.read(ref.name)
        if (!text) return { ok: false, counts: {}, error: `缺少祖先 part：${ref.name}` }
        const payload = JSON.parse(text) as { entities: ContentBaselineFile['entities'] }
        const checksum = `fnv1a64:${hashContentValue(payload.entities.map(({ type, key, hash }) => ({ type, key, hash })))}`
        if (checksum !== ref.checksum) return { ok: false, counts: {}, error: `祖先 part 校验失败：${ref.name}` }
        entities.push(...payload.entities)
      }
      baseFile = { format: 'momo-content-baseline', formatVersion: 1, manifest: index.manifest, entities, checksum: '' }
    } else return { ok: false, counts: {}, error: '缺少祖先基线或链断' }
    const result = await restoreContentIncrementChain(baseFile, chain, { skipWriteLock: true })
    return finish({ ok: result.ok, counts: {}, ...(result.error ? { error: result.error } : {}) })
  } catch (error) {
    return finish({ ok: false, counts: {}, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * P1-4：启动时消费内容恢复 journal。
 * 若上次 restore 在写 content_kv/cache 过程中被 kill，不能从半替换的 kv 自动重建 cache；
 * 标记 interrupted + dirty，由 UI 引导用户先恢复备份。正常失败 marker 带 error，也视为需用户确认。
 */
export async function consumeInterruptedContentRestore(): Promise<{ interrupted: boolean; id?: string; error?: string }> {
  try {
    const row = await getDb().meta.get('content.restore.stageNow')
    const value = row?.value as { id?: string; error?: string; at?: number } | undefined
    if (!value) return { interrupted: false }
    await getDb().meta.put({
      key: 'content.restore.interrupted',
      value: { id: value.id ?? '', error: value.error ?? null, at: value.at ?? Date.now() },
      updatedAt: Date.now(),
    })
    const { markIdbCacheDirty } = await import('./idb-cache')
    await markIdbCacheDirty('content-restore-interrupted').catch(() => undefined)
    return { interrupted: true, ...(value.id ? { id: value.id } : {}), ...(value.error ? { error: value.error } : {}) }
  } catch {
    return { interrupted: false }
  }
}

/** 用户确认“已知中断，稍后恢复”后清除引导标记；不清 stageNow，避免掩盖未恢复事实 */
export async function acknowledgeInterruptedContentRestore(): Promise<void> {
  await getDb().meta.delete('content.restore.interrupted').catch(() => undefined)
}

export async function getContentBackupStatus(): Promise<ContentBackupStatus> {
  const settings = await getSettings().catch(() => null)
  const chain = await getContentChainState().catch(() => null)
  const baseline = (await getDb().meta.get(LAST_BASELINE_META))?.value as { at?: number } | undefined
  const increment = (await getDb().meta.get(LAST_INCREMENT_META))?.value as { at?: number } | undefined
  return {
    enabled: settings?.['backup.autoContentEnabled'] === true,
    lastBaseline: baseline?.at ?? null,
    lastIncrement: increment?.at ?? null,
    lastSuccess: chain?.updatedAt ?? null,
    consecutiveFailures: chain?.consecutiveFailures ?? 0,
    needsFullSnapshot: chain?.needsFullSnapshot ?? true,
    chainBroken: chain?.needsFullSnapshot ?? true,
    ...(storage ? {} : { error: '内容备份存储未初始化' }),
  }
}

export async function runContentAutoBackup(opts: { force?: boolean } = {}): Promise<{ ok: boolean; mode: 'baseline' | 'increment' | 'skipped'; error?: string }> {
  if (contentAutoRunning) return { ok: false, mode: 'skipped', error: '已有内容备份在进行中' }
  contentAutoRunning = true
  try {
  const status = await getContentBackupStatus()
  if (!status.enabled && !opts.force) return { ok: false, mode: 'skipped', error: '未开启（backup.autoContentEnabled=false）' }
  if (status.needsFullSnapshot || !status.lastBaseline) {
    const result = await createContentBaseline()
    return result.ok ? { ok: true, mode: 'baseline' } : { ok: false, mode: 'baseline', error: result.error }
  }
  const result = await createContentIncrement()
  if (result.ok) return { ok: true, mode: 'increment' }
  if (result.mode === 'full-required') {
    const full = await createContentBaseline()
    return full.ok ? { ok: true, mode: 'baseline' } : { ok: false, mode: 'baseline', error: full.error }
  }
  return { ok: false, mode: 'increment', error: result.error }
  } finally {
    contentAutoRunning = false
  }
}
