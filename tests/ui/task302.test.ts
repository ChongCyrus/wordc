import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const study = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
  'utf8',
)
const stage = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/RootAffixStage.tsx', import.meta.url)),
  'utf8',
)

describe('task-302 0.8.0 只记词根缀 UI 骨架', () => {
  it('设置/互斥/三小次接线', () => {
    expect(study).toContain('memory.rootAffixOnly')
    expect(study).toContain('只记词根缀')
    expect(study).toContain('memory.weightedCoreSenseOnly')
    expect(study).toContain("'memory.rootAffixOnly': false")
    expect(study).toContain('threeTapRecall={appSettings?.[\'memory.threeTapRecall\'] !== false}')
    expect(study).toContain('RootAffixStage')
    expect(study).toContain('const rootAffixMapping = study.word')
    expect(study).toContain('rootAffixMapping?.ok')
  })

  it('可退出回注释面；评分栏在 StudyPage 复用', () => {
    expect(study).toContain('onExit={() => actions.exitMemory()}')
    expect(study).toContain('<ActionBar')
    expect(study).toContain("stage === 'annotation'")
  })

  it('无词源回退普通模式；卡片含类型/键/值/代表词/最终组合', () => {
    expect(study).toContain('rootAffixEnabled && rootAffixMapping?.ok')
    expect(stage).toContain('TYPE_LABEL')
    expect(stage).toContain('wc-info-example')
    expect(stage).toContain('RootAffixMappingsResult')
    expect(stage).toContain('mapping.items')
    expect(stage).toContain('examples')
    expect(stage).toContain('showMeaning')
    expect(stage).toContain('点击显示含义')
  })
})
