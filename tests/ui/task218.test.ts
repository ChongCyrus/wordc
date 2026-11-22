import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const hook = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/hooks/useStudySession.ts', import.meta.url)),
  'utf8',
)
const page = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
  'utf8',
)

describe('task-218 本义 encounters 与 c 同机制', () => {
  it('boardTap 内与 c 同分支记录 core encounters；旧 wordId 去重 effect 已移除', () => {
    expect(hook).toContain('shouldRecordEncounters')
    expect(hook).toContain('recordCoreSenseEncounters(next.word.wordId, coreSenses)')
    expect(hook).toContain('recordMeaningEncounters(next.word.wordId, meaningIds)')
    expect(hook).toContain('setCoreSenseStats(coreUpdated.coreSenseStats ?? {})')
    expect(page).not.toContain('coreEncounteredRef')
    expect(page).not.toContain('recordCoreSenseEncounters')
  })

  it('本义 stats 状态由 hook 统一提供，点击用 markCoreSense 刷新', () => {
    expect(hook).toContain('const [coreSenseStats, setCoreSenseStats]')
    expect(hook).toContain('coreSenseStats,')
    expect(hook).toContain('markCoreSense: handleMarkCoreSense')
    expect(page).toContain('study.coreSenseStats')
    expect(page).toContain('study.actions.markCoreSense')
  })
})
