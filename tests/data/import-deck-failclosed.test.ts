import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { importDeckFile, persistLearningWriteSource } from '../../src/data'
afterEach(async () => { await persistLearningWriteSource('idb') })
describe('rc15 importDeckFile sqlite', () => {
  it('非法文件返回 report 而非只在 IDB 写', async () => {
    await persistLearningWriteSource('sqlite')
    const report = await importDeckFile('{}')
    expect(report.ok).toBe(false)
  })
})
