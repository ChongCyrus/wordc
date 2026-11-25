/** 0.12 A：ContentBackupStorage 适配现有自动备份桥（App 私有目录，gzip/原子写） */
import type { AutoBackupBridge, ContentBackupStorage } from '../../data'
import { createAutoBackupBridge } from './auto-backup-service'

export const CONTENT_BACKUP_PREFIX = 'content-'
const CONTENT_NAME = /^content-.*\.json(\.gz)?$/

export function createContentBackupStorage(bridge: AutoBackupBridge = createAutoBackupBridge()): ContentBackupStorage {
  return {
    async save(text, name) {
      const saved = await bridge.save(text, name)
      return { ok: saved.ok, name: saved.name ?? name, ...(saved.error ? { error: saved.error } : {}) }
    },
    read(name) {
      return bridge.read(name)
    },
    list() {
      return bridge.list().filter((entry) => CONTENT_NAME.test(entry.name) && entry.size > 0)
    },
    delete(name) {
      return bridge.delete(name)
    },
  }
}

/** 链保留：最近1基线(index+parts) + 最多6增量；不动 migration 文件 */
export function pruneContentBackups(storage: ContentBackupStorage, keepBase = 1, keepIncrements = 6): number {
  const files = storage.list().sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  const indexes = files.filter((file) => /^content-baseline-.*-index\.json(\.gz)?$/.test(file.name))
  for (const old of indexes.slice(keepBase)) {
    const prefix = old.name.replace(/-index\.json(\.gz)?$/, '')
    for (const file of files) {
      if (file.name === old.name || file.name.startsWith(`${prefix}-part-`)) {
        if (storage.delete(file.name)) removed += 1
      }
    }
  }
  let increments = 0
  for (const file of files.filter((entry) => entry.name.startsWith('content-increment-'))) {
    increments += 1
    if (increments > keepIncrements && storage.delete(file.name)) removed += 1
  }
  // 兼容旧单文件基线命名
  let legacyBases = 0
  for (const file of files.filter((entry) => /^content-baseline-\d+.*\.json(\.gz)?$/.test(entry.name) && !entry.name.includes('-index.') && !entry.name.includes('-part-'))) {
    legacyBases += 1
    if (legacyBases > keepBase && storage.delete(file.name)) removed += 1
  }
  return removed
}
