import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const study = src('ui/study/StudyPage.tsx')
const card = src('ui/study/components/RootEtymologyCard.tsx')
const stage = src('ui/study/components/RootAffixStage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-303 0.9.0 词根缀不熟悉度/加权次数', () => {
  it('chip 本身温度计：背景填充 + 百分比，无额外线', () => {
    expect(card).toContain('normalizePartKey')
    expect(card).toContain('linear-gradient(to right')
    expect(card).toContain('root-etymology-part-percent')
    expect(card).not.toContain('root-etymology-part-meter')
    expect(study).toContain('onPartClick={markPartUnfamiliar}')
    expect(css).toContain('.wc-card.root-affix-card-fill')
    expect(css).toContain('--part-fill')
  })

  it('hooks 顺序：#310 回归防护（StudyPage 新 effect 在提前 return 之前）', () => {
    const firstEarlyReturn = study.indexOf("if (tempMode && study.tempSummary)")
    const laterHooks = study.indexOf('recordPartEncounters')
    expect(firstEarlyReturn).toBeGreaterThan(0)
    expect(laterHooks).toBeGreaterThan(0)
    expect(study.indexOf('useEffect(() => {\n    if (!study.word) return')).toBeLessThan(firstEarlyReturn)
    expect(study.indexOf('rootEtymologyAndStats')).toBe(-1)
  })

  it('注释面 encounters + click；加权次数/已记 x/N', () => {
    expect(study).toContain('partEncounteredRef')
    expect(study).toContain('recordPartEncounters')
    expect(study).toContain('recordPartClick')
    expect(study).toContain('getPartStats')
    expect(study).toContain('getPartTotals')
    expect(study).toContain('remotePartTotals')
    expect(stage).toContain('{Math.min(currentCount, currentTotal)} / {currentTotal}')
    expect(stage).toContain('wc-info-caption')
    expect(stage).toContain('wc-dots')
    expect(stage).not.toContain('退出根缀模式')
    expect(stage).toContain('currentCount + 1 < currentTotal')
    expect(stage).toContain('threeTapRecall && tapCount === 0')
  })
})
