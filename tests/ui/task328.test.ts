import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const hook = src('ui/study/hooks/useStudySession.ts')
const study = src('ui/study/StudyPage.tsx')

describe('task-328 加权勾选立即反映/互斥', () => {
  it('updateSettings 返回值同步 setSettingsState + settingsRef，并用 updated reload', () => {
    expect(hook).toContain('const updated = await updateSettings({')
    expect(hook).toContain('setSettingsState(updated)')
    expect(hook).toContain('settingsRef.current = updated')
    expect(hook).toContain('loadWordAt(currentPlan.index, currentPlan, updated, { startAt: \'annotation\' })')
    expect(hook).toContain("'memory.weightedCoreSenseOnly': coreOnly")
    expect(hook).toContain("'memory.rootAffixOnly': rootOnly")
  })

  it('checkbox checked 直接来自 appSettings（core/root 各自单键）', () => {
    expect(study).toContain("checked={appSettings?.['memory.weightedCoreSenseOnly'] === true}")
    expect(study).toContain('checked={rootAffixEnabled}')
    expect(study).toContain('disabled={weightedModeBusy}')
    expect(study).toContain("changeWeightedMemoryMode(event.target.checked ? 'core' : 'normal')")
    expect(study).toContain("changeWeightedMemoryMode(event.target.checked ? 'root' : 'normal')")
  })
})
