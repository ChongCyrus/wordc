/** 0.3.73：本义串联助记 repo/迁移 + AI */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildMigrationFile,
  clearCoreSenseOverview,
  createDeck,
  getCoreSenseOverview,
  getWord,
  importMigration,
  resetDatabase,
  saveCoreSenseOverview,
} from '../../src/data'
import {
  generateCoreSenseOverview,
  validateCoreSenseOverviewDraft,
} from '../../src/data/ai'
import type { AiConfig, ChatResponse, LlmProvider } from '../../src/data/ai'
import { PROMPT_VERSION_CORE_SENSE_OVERVIEW } from '../../src/data/ai/prompts'

const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-fake',
  transport: 'auto',
  batchSize: 20,
  maxCostPerRun: 3,
  jsonMode: true,
}
const SOURCE = {
  word: 'denounce',
  coreSenses: [
    { index: 1, label: '公开指责', note: '当众斥其非', origin: 'de+ nounce' },
    { index: 2, label: '告发' },
  ],
  mappedMeanings: [
    { coreSenseIndex: 1, meaningIndex: 1, cn: '谴责' },
    { coreSenseIndex: 2, meaningIndex: 2, cn: '告发' },
  ],
}

describe('0.3.73 · coreSenseOverview', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('save/get/clear；迁移往返包含 overview', async () => {
    const deck = await createDeck({ name: 'overview', words: [{ headword: 'denounce', meanings: [{ cn: '谴责' }] }] })
    const wordId = `${deck.id}:denounce`
    expect(await getCoreSenseOverview(wordId)).toBeNull()
    await saveCoreSenseOverview(wordId, { text: '从公开指责到告发，核心是当众宣告其非。', source: 'ai' })
    expect((await getCoreSenseOverview(wordId))?.text).toContain('公开指责')

    const file = await buildMigrationFile({ includeReviewLogs: false })
    const text = JSON.stringify(file)
    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect((await getWord(wordId))?.coreSenseOverview?.text).toContain('告发')

    await clearCoreSenseOverview(wordId)
    expect(await getCoreSenseOverview(wordId)).toBeNull()
  })

  it('AI：prompt/合法 JSON/非法空/超时/成本预检', async () => {
    const okProvider: LlmProvider = {
      id: 'deepseek',
      async chat() {
        return { text: JSON.stringify({ text: '本义一当众斥其非，本义二告发；由公开指责引申到告发。' }), usage: { input: 10, output: 20, total: 30 } }
      },
    }
    const result = await generateCoreSenseOverview(SOURCE, CFG, { provider: okProvider })
    expect(result.promptVersion).toBe(PROMPT_VERSION_CORE_SENSE_OVERVIEW)
    expect(result.text).toContain('告发')
    expect(() => validateCoreSenseOverviewDraft({})).toThrow(/缺少 text/)
    expect(() => validateCoreSenseOverviewDraft({ text: '  ' })).toThrow(/缺少 text/)

    const hanging: LlmProvider = { id: 'deepseek', async chat() { return new Promise<ChatResponse>(() => undefined) } }
    await expect(generateCoreSenseOverview(SOURCE, CFG, { provider: hanging, timeoutMs: 100 })).rejects.toThrow(/超时/)
    const tiny: AiConfig = { ...CFG, maxCostPerRun: 0.00001 }
    await expect(generateCoreSenseOverview(SOURCE, tiny, { provider: okProvider })).rejects.toThrow(/超过单次上限/)
  }, 10_000)
})
