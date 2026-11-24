import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const hook = src('ui/study/hooks/useStudySession.ts')
const study = src('ui/study/StudyPage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-327 P0 加权模式原子切换', () => {
  it('单一 action 原子写两键，只 reload/open 一次，toast 分模式', () => {
    expect(hook).toContain('setWeightedMemoryMode')
    expect(hook).toContain("'memory.weightedCoreSenseOnly': coreOnly")
    expect(hook).toContain("'memory.rootAffixOnly': rootOnly")
    expect(hook).toContain("已切换为只记词根缀")
    expect(hook).toContain('已恢复含义加权')
    expect(hook).toContain('loadWordAt(currentPlan.index, currentPlan, nextSettings, { startAt: \'annotation\' })')
    expect(study).toContain('changeWeightedMemoryMode')
    expect(study).toContain('disabled={weightedModeBusy}')
    expect(study).not.toContain("void study.actions.updateStudySettings({ 'memory.rootAffixOnly'")
  })

  it('根缀卡紧凑/两列', () => {
    expect(css).toContain('.root-affix-stage .wc-info')
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(css).toContain('min-height: min(38vh, 300px)')
  })
})
