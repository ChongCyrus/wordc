import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { consumeInterruptedContentRestore, getDb, rebuildContentCacheFromSqlite, resetDatabase } from '../../src/data'

describe('0.15 P1-4 内容恢复 journal', () => {
  afterEach(() => {
    delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge
  })

  it('检测中断 marker：标 interrupted、cache dirty，拒绝从半替换 kv 重建', async () => {
    await resetDatabase()
    ;(globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge = { isNativeApp: () => 'momo-apk' }
    await primeLegacySqliteContentSource()
    await getDb().meta.put({ key: 'content.restore.stageNow', value: { id: 'base-x', at: Date.now() }, updatedAt: Date.now() })
    const result = await consumeInterruptedContentRestore()
    expect(result.interrupted).toBe(true)
    expect(result.id).toBe('base-x')
    expect(await getDb().meta.get('content.restore.interrupted')).toBeTruthy()
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok).toBe(false)
    expect(rebuilt.error ?? '').toMatch(/恢复被中断/)
  })
})
