import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { exportMigrationText, getSettings, importMigration, persistLearningWriteSource, resetDatabase, updateSettings } from '../../src/data'
afterEach(async () => { await persistLearningWriteSource('idb') })
describe('task-307 A-03 AI key survives replace', () => {
  it('replace 导入不丢本机 ai.apiKey（包内本就不含）', async () => {
    await resetDatabase()
    await updateSettings({ 'ai.apiKey': 'sk-local-307' })
    const text = await exportMigrationText()
    await resetDatabase()
    await updateSettings({ 'ai.apiKey': 'sk-target-307' })
    const report = await importMigration(text, { strategy: 'replace', preBackup: async () => ({ ok: true }) })
    expect(report.ok).toBe(true)
    expect((await getSettings())['ai.apiKey']).toBe('sk-target-307')
  })
})
