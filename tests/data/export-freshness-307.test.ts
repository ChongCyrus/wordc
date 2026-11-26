import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMigrationFile, getDb, markIdbCacheDirty, persistLearningWriteSource, resetDatabase } from '../../src/data'
import { getIdbCacheMeta, clearIdbCacheDirty } from '../../src/data/idb-cache'
afterEach(async () => { await persistLearningWriteSource('idb') })
describe('task-307 A-01 export freshness', () => {
  it('sqlite 写源 + dirty 且刷新失败 → 导出报错，不出假备份', async () => {
    await resetDatabase(); await persistLearningWriteSource('sqlite')
    await markIdbCacheDirty('test-dirty')
    await expect(buildMigrationFile()).rejects.toThrow(/缓存|dirty|刷新/)
  })
  it('sqlite 写源 + dirty 可刷新清掉 → 导出成功', async () => {
    await resetDatabase(); await persistLearningWriteSource('sqlite')
    await markIdbCacheDirty('test-dirty')
    const meta = await getIdbCacheMeta()
    await clearIdbCacheDirty(meta ?? { generation: 0, sqliteUserVersion: 3, dirty: false })
    const file = await buildMigrationFile()
    expect(file.format).toBe('momo-migration')
    expect(await getDb().states.count()).toBe(0)
  })
})
