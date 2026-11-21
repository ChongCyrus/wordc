import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const hook = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/hooks/useStudySession.ts', import.meta.url)),
  'utf8',
)

describe('task-220 退出再进只记本义内容恢复', () => {
  it('重进时复用 pseudo core word 的 units，不因 effective 读取退回普通加权', () => {
    expect(hook).toContain('const pseudoCore = current.word.meanings')
    expect(hook).toContain('meaning.meaningId.startsWith(CORE_SENSE_MEANING_PREFIX)')
    expect(hook).toContain('buildCoreSenseWeightedUnits({')
    expect(hook).toContain('toCoreSenseSessionWord(current.word, built.units)')
    expect(hook).toContain('weightedTotals: built.totals')
  })

  it('冷启动：读取最新设置、主动拉取 saved views、refresh action 在保存后触发', () => {
    expect(hook).toContain('await getSettings()')
    expect(hook).toContain("['memory.weightedCoreSenseOnly'] === true")
    expect(hook).toContain('coreSenseContentFallback')
    expect(hook).toContain('const firstUnit = built.units[0]')
    expect(hook).toContain('setCoreSenseContentFallback({')
    expect(hook).toContain('listCoreSenseExampleViews(wordId)')
    expect(hook).toContain('listCoreSensePhraseViews(wordId)')
    expect(hook).toContain('listCoreSenseExampleViews(wordId)')
    const page = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    expect(page).toContain('refreshCoreSenseContent()')
    expect(page).toContain('memoryProgress.total')
  })

  it('UI 保存本义助记后注释面同步刷新（共用 Word.senseMnemonics）', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    expect(page).toContain('listSenseMnemonicViews(session.word.wordId)')
    expect(page).toContain('setSenseMnemonics(')
  })

  it('coreSenseContent 重新挂载/重进时会重新订阅读取；active id 缺失时从 core meanings 兜底', () => {
    expect(hook).toContain('session?.word.meanings.find((meaning) =>')
    expect(hook).toContain('meaning.meaningId.startsWith(CORE_SENSE_MEANING_PREFIX),')
    expect(hook).toContain('listCoreSenseExampleViews(wordId)')
    expect(hook).toContain('listCoreSensePhraseViews(wordId)')
    expect(hook).toContain('session?.stage,')
    expect(hook).toContain('effectiveSemanticsRef')
    expect(hook).toContain('cachedCoreSenses')
    expect(hook).toContain('const coreEncountersPromise')
    expect(hook).not.toContain('coreSenseContent = useMemo')
  })
})
