/** 0.14：从 content_kv 重建 IDB 内容 cache；先清内容表→seed 内置正文→应用自定义/overlay→重放 packs */
import { applyContentCache, type ContentEntityRow } from './content-write-source'
import { readContentCounts, type ContentKvRow } from './content-store'
import { getDb } from './db'
import { ensureBuiltinDecks } from './builtin'
import { reapplyAppliedPacks } from './packs.repo'
import { markIdbCacheDirty, writeIdbCacheMeta } from './idb-cache'
import { getDataEpoch } from './data-epoch'
import { SQLITE_SCHEMA_VERSION } from './sqlite-store'

export interface ContentCacheRebuildResult { ok: boolean; rows: number; revision: number; error?: string }

const CONTENT_META_PREFIXES = ['derivationMap:', 'userNote:', 'userMnemonic:', 'rootEtymology:']

async function snapshotCache(): Promise<{ decks: unknown[]; words: unknown[]; packs: unknown[]; packItems: unknown[]; rejects: unknown[]; meta: Array<{ key: string; value: unknown; updatedAt: number }> }> {
  const db = getDb()
  return { decks: await db.decks.toArray(), words: await db.words.toArray(), packs: await db.packs.toArray(), packItems: await db.packItems.toArray(), rejects: await db.contentRejects.toArray(), meta: (await db.meta.toArray()).filter((row) => CONTENT_META_PREFIXES.some((prefix) => row.key.startsWith(prefix))) }
}

async function restoreCache(snapshot: Awaited<ReturnType<typeof snapshotCache>>): Promise<void> {
  const db = getDb()
  await db.transaction('rw', [db.decks, db.words, db.packs, db.packItems, db.contentRejects, db.meta], async () => {
    await db.decks.clear(); await db.words.clear(); await db.packs.clear(); await db.packItems.clear(); await db.contentRejects.clear()
    await db.decks.bulkPut(snapshot.decks as never); await db.words.bulkPut(snapshot.words as never); await db.packs.bulkPut(snapshot.packs as never); await db.packItems.bulkPut(snapshot.packItems as never); await db.contentRejects.bulkPut(snapshot.rejects as never)
    for (const row of snapshot.meta) await db.meta.put(row as never)
  })
}

export interface ContentCacheRebuildTestHooks {
  applyRows?: (rows: ContentEntityRow[]) => Promise<void>
  restoreCache?: () => Promise<void>
  seed?: () => Promise<void>
}

export async function rebuildContentCacheFromSqlite(opts: { testHooks?: ContentCacheRebuildTestHooks } = {}): Promise<ContentCacheRebuildResult> {
  const hooks = opts.testHooks
  const { getContentWriteSource } = await import('./content-write-source')
  if ((await getContentWriteSource()) !== 'sqlite') return { ok: false, rows: 0, revision: 0, error: 'contentWriteSource 不是 sqlite，拒绝从 content_kv 重建' }
  // P1-4：内容恢复中断时禁止从可能半替换的 content_kv 重建 cache
  try {
    const interrupted = await getDb().meta.get('content.restore.stageNow')
    if (interrupted) return { ok: false, rows: 0, revision: 0, error: '上次内容恢复被中断，请先恢复内容备份再重建 cache' }
  } catch { /* ignore */ }
  const { getContentMigrationState } = await import('./content-migration-plan')
  const { isContentMigrationV15Done } = await import('./content-write-source')
  const migration = await getContentMigrationState()
  // 0.15：v15 单一事实源已 done 时不再要求 0.14 contentMigrationState=ready（fresh/already-done 不写它）
  if (migration?.status !== 'ready' && !(await isContentMigrationV15Done())) {
    return { ok: false, rows: 0, revision: 0, error: '内容迁移未 ready 且 v15 未完成，拒绝重建' }
  }
  const db = getDb()
  const backup = await snapshotCache()
  // P1：重建 apply 过程被 kill 时 cache 不能算干净；先标 dirty，成功后再写 clean meta
  await markIdbCacheDirty('content-cache-rebuild-start').catch(() => undefined)
  try {
    const counts = await readContentCounts()
    const rows: ContentKvRow[] = []
    const seen = new Set<string>()
    const { listContentRowsPage } = await import('./content-store')
    for (let offset = 0; offset < 1_000_000; offset += 500) {
      const page = await listContentRowsPage({ offset, limit: 500, includeDeleted: true, orderBy: 'key' })
      if (!page.ok) throw new Error(page.error ?? '读取 content_kv 失败')
      let added = 0
      for (const row of page.rows) if (!seen.has(row.key)) { seen.add(row.key); rows.push(row); added += 1 }
      if (page.hasMore && added === 0) throw new Error('contentList 分页无进展（added=0），拒绝截断重建')
      if (!page.hasMore || page.rows.length === 0) break
    }
    const custom = rows.filter((row) => row.deleted === 0 && (row.kind === 'deck' || row.kind === 'word' || row.kind === 'pack' || row.kind === 'pack-item' || row.kind === 'content-reject' || row.kind === 'meta'))
    const overlays = rows.filter((row) => row.deleted === 0 && row.kind === 'word-overlay')
    const deletedPacks = new Set(rows.filter((row) => row.deleted === 1 && row.kind === 'pack').map((row) => row.key.replace(/^pack:/, '')))
    // F3a：先清 IDB 内容，再 seed 内置正文，最后应用自定义/overlay；避免 overlay 被内置 word put 覆盖
    await db.transaction('rw', [db.decks, db.words, db.packs, db.packItems, db.contentRejects, db.meta], async () => {
      await db.decks.clear(); await db.words.clear(); await db.packs.clear(); await db.packItems.clear(); await db.contentRejects.clear()
      const metaRows = (await db.meta.toArray()).filter((row) => CONTENT_META_PREFIXES.some((prefix) => row.key.startsWith(prefix)))
      for (const row of metaRows) await db.meta.delete(row.key)
    })
    const seeded = hooks?.seed ? await hooks.seed().then(() => ({ ok: true })) : await ensureBuiltinDecks({ force: true })
    if (seeded && 'ok' in seeded && seeded.ok === false) throw new Error(`seed 内置正文失败：${(seeded as { error?: string }).error ?? '未知'}`)
    const entityRows: ContentEntityRow[] = [...custom, ...overlays].map((row) => ({ key: row.key, kind: row.kind, json: row.json, updatedAt: row.updatedAt }))
    if (hooks?.applyRows) await hooks.applyRows(entityRows)
    else await applyContentCache(entityRows)
    // 0.15：按 content_kv 的 key 集合校验 cache 实际应用结果，避免内置 deck/custom 内置词口径误差
    const liveKeys = new Set(rows.filter((row) => row.deleted === 0).map((row) => row.key))
    const expectedByKind = new Map<string, number>()
    for (const row of rows) if (row.deleted === 0) expectedByKind.set(row.kind, (expectedByKind.get(row.kind) ?? 0) + 1)
    const dbRows = await Promise.all([db.decks.toArray(), db.words.toArray(), db.packs.toArray(), db.packItems.toArray(), db.contentRejects.toArray()])
    const actualByKind: Record<string, number> = {
      deck: dbRows[0].filter((row) => liveKeys.has(`deck:${row.id}`)).length,
      word: dbRows[1].filter((row) => liveKeys.has(`word:${row.id}`)).length,
      pack: dbRows[2].filter((row) => liveKeys.has(`pack:${row.id}`)).length,
      'pack-item': dbRows[3].filter((row) => liveKeys.has(`pack-item:${row.id}`)).length,
      'content-reject': dbRows[4].filter((row) => liveKeys.has(`content-reject:${row.id}`)).length,
    }
    for (const [kind, expected] of expectedByKind) {
      if (kind === 'meta' || kind === 'word-overlay') continue
      const actual = actualByKind[kind] ?? 0
      if (actual !== expected) throw new Error(`重建 counts 不一致（${kind}: ${actual}/${expected}）`)
    }
    // F3b：已应用 pack 重放；已删除 pack 不复活的 packItems 在 content_kv 中本就不存在
    await reapplyAppliedPacks().catch(() => undefined)
    if (deletedPacks.size > 0) {
      for (const id of deletedPacks) { await db.packs.delete(id); await db.packItems.where('packId').equals(id).delete() }
    }
    if (counts.total < rows.filter((row) => row.deleted === 0).length) throw new Error(`content_kv counts 不一致：${counts.total}`)
    await getDb().meta.put({ key: 'contentCacheRebuild.diag', value: { at: Date.now(), rows: rows.length, revision: counts.revision }, updatedAt: Date.now() }).catch(() => undefined)
    // P1：重建成功必须更新 cache meta，否则 AppShell 每次启动都会重复重建并长时间持锁
    await writeIdbCacheMeta({ generation: await getDataEpoch().catch(() => 0), sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false, rebuiltAt: Date.now() }).catch(() => undefined)
    return { ok: true, rows: rows.length, revision: counts.revision }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markIdbCacheDirty(`content-cache-rebuild: ${message}`).catch(() => undefined)
    await getDb().meta.put({ key: 'contentCacheRebuild.diag', value: { at: Date.now(), ok: false, error: message }, updatedAt: Date.now() }).catch(() => undefined)
    let rollbackError: string | undefined
    try { if (hooks?.restoreCache) await hooks.restoreCache(); else await restoreCache(backup) } catch (rollback) { rollbackError = rollback instanceof Error ? rollback.message : String(rollback) }
    await getDb().meta.put({ key: 'contentCacheRebuild.diag', value: { at: Date.now(), ok: false, error: message, rollbackError }, updatedAt: Date.now() }).catch(() => undefined)
    return { ok: false, rows: 0, revision: 0, error: rollbackError ? `${message}；旧 cache 恢复失败：${rollbackError}` : message }
  }
}
