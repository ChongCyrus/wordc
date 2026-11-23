import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const memory = src('ui/study/components/MemoryStage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-285 w-c 顶部推荐流程', () => {
  it('非三小次顶部流程替换；三小次保持单行', () => {
    expect(memory).toContain('词根词缀法记忆流程')
    expect(memory).toContain('“词根缀源 → 词根缀源的含义”')
    expect(memory).toContain('<details className="wc-root-process">')
    expect(memory).toContain('之后白板页复习也是根据')
    expect(memory).not.toContain('请熟悉/记忆下述映射')
    expect(memory).not.toContain('请进行下述次数')
    expect(css).toContain('.wc-root-process')
    const study = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    expect(study).toContain('rootEtymology={')
    expect(study).toContain("appSettings?.['study.showRootEtymology'] !== false")
    expect(study).toContain('memory.threeTapRecall')
    expect(study).toContain('updateStudySettings')
    const settingsPage = src('ui/me/SettingsPage.tsx')
    expect(settingsPage).not.toContain('记忆三小次（先回忆再核对）')
  })
})
