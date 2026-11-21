import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { RootEtymologyCard } from '../../src/ui/study/components/RootEtymologyCard'
import { RootEtymologyBatchPanel } from '../../src/ui/ai/RootEtymologyBatchPanel'
import { AppProviders } from '../../src/app/providers'
import { RareMeaningsBatchPanel } from '../../src/ui/ai/RareMeaningsBatchPanel'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-286 词根词缀词源 UI', () => {
  it('卡片每 part 显示 类型·文本·含义；无数据可编辑', () => {
    const html = renderToStaticMarkup(
      createElement(RootEtymologyCard, {
        data: {
          parts: [
            { type: 'prefix', text: 'ab-', meaning: '离开' },
            { type: 'root', text: 'duc', meaning: '引导' },
          ],
          etymology: '拉丁语',
          composition: '离开+引导=带走',
          source: 'manual',
          updatedAt: 1,
        },
        onEdit: () => undefined,
      }),
    )
    expect(html).toContain('词根词缀词源')
    expect(html).toContain('前缀')
    expect(html).toContain('ab-')
    expect(html).toContain('离开')
    expect(html).toContain('词根')
    expect(html).toContain('duc')
    expect(html).toContain('引导')
    expect(html).toContain('带走')
  })

  it('编辑/AI/设置/批量接入；含义必填与校验', () => {
    const edit = src('ui/study/components/RootEtymologyEditDialog.tsx')
    const study = src('ui/study/StudyPage.tsx')
    const memory = src('ui/study/components/MemoryStage.tsx')
    const settings = src('ui/me/SettingsPage.tsx')
    const ai = src('ui/ai/AiGeneratePanel.tsx')
    const batch = src('ui/ai/RootEtymologyBatchPanel.tsx')
    expect(edit).toContain('validateRootEtymologyDraft')
    expect(edit).toContain('AI 生成')
    expect(edit).toContain('+ 添加部分')
    expect(edit).toContain('部分含义')
    expect(study).toContain('RootEtymologyCard')
    expect(study).toContain('study.showRootEtymology')
    expect(memory).toContain('wc-root-etymology')
    expect(memory).toContain('·${part.meaning}')
    expect(settings).toContain('显示词根词缀词源')
    expect(ai).toContain('RootEtymologyBatchPanel')
    expect(batch).toContain('getRootEtymologyCandidates')
    expect(batch).toContain('applyRootEtymologyResults')
    expect(batch).toContain('·{part.meaning}')
  })
})

describe('task-286 batch panel open guard', () => {
  it('open=false 时不渲染全屏 dialog', () => {
    const root = renderToStaticMarkup(
      createElement(
        AppProviders,
        null,
        createElement(RootEtymologyBatchPanel, {
          open: false,
          onClose: () => undefined,
          selectedWordIds: [],
        }),
      ),
    )
    const rare = renderToStaticMarkup(
      createElement(
        AppProviders,
        null,
        createElement(RareMeaningsBatchPanel, {
          open: false,
          onClose: () => undefined,
        }),
      ),
    )
    expect(root).not.toContain('批量生成词根词缀词源')
    expect(rare).not.toContain('批量标记不常考含义/本义')
    expect(root).not.toContain('role="dialog"')
    expect(rare).not.toContain('role="dialog"')
  })
})

describe('task-286 w-c 系统返回', () => {
  it('memory 阶段 registerNativeBack 退出记忆返回注释面', () => {
    const study = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    expect(study).toContain("if (stage === 'memory')")
    expect(study).toContain('actions.exitMemory()')
    expect(study).toContain('return true')
    expect(study).toContain("addEventListener('popstate', onPopState, true)")
    expect(study).toContain('stopImmediatePropagation')
    expect(study).toContain('momoWcBack')
    const hook = readFileSync(fileURLToPath(new URL('../../src/ui/study/hooks/useStudySession.ts', import.meta.url)), 'utf8')
    expect(hook).toContain('详情冷启动不走语义包聚合')
    expect(hook).toContain('void recordMeaningEncounters')
    expect(study).toContain("pushState({ momoWcBack: true }")
    expect(study).toContain('ignoreNextPopRef')
  })
})
