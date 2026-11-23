import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'
import { ToastProvider } from '../../src/app/toast'
import { BoardStage } from '../../src/ui/study/components/BoardStage'
import {
  rareMeaningIdsFromIndexes,
  RareMeaningsBatchPanel,
} from '../../src/ui/ai/RareMeaningsBatchPanel'

const noop = () => undefined
const settingsPage = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/SettingsPage.tsx', import.meta.url)),
  'utf8',
)
const studyPage = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
  'utf8',
)
const hook = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/hooks/useStudySession.ts', import.meta.url)),
  'utf8',
)

function annotation(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(AnnotationStage, {
      headword: 'margin',
      phonetic: '',
      showPhonetic: false,
      coreSenses: [],
      meanings: [
        { meaningId: 'm1', pos: 'n.', cn: '边缘', clicks: 0, encounters: 1, familiarity: 0 },
        { meaningId: 'm2', pos: 'n.', cn: '利润', clicks: 0, encounters: 1, familiarity: 0 },
      ],
      examples: [],
      mnemonics: [],
      ncMeaningIds: ['m1'],
      rareMeaningIds: ['m2'],
      rootLabel: '边缘',
      rootParagraph: '本义/核心义：边缘',
      rootMnemonicText: '边缘是生成元',
      onEditRootMnemonic: noop,
      onToggleRareMeaning: noop,
      onAiMarkRare: noop,
      onMarkMeaning: noop,
      phrases: [],
      showPhrases: false,
      speaking: false,
      onSpeak: noop,
      ...props,
    } as never),
  )
}

describe('task-197：生成元/不常考/白板 nc', () => {
  it('注释面显示 w↓rootLabel + 第一段 + 映射助记按钮；nc/不常考徽标', () => {
    const html = annotation()
    expect(html).toContain('annotation-root-mapping')
    expect(html).toContain('margin')
    expect(html).toContain('↓')
    expect(html).toContain('边缘')
    expect(html).toContain('本义/核心义：边缘')
    expect(html).toContain('映射助记：边缘是生成元')
    expect(html).toContain('AI助记·生成元映射')
    expect(html).toContain('nc-badge')
    expect(html).toContain('rare-badge')
    // 0.3.64：nc/不常考徽标移到中文前，避免右缘被「引申」遮挡
    expect(html.indexOf('nc-badge')).toBeLessThan(html.indexOf('边缘</span>', html.indexOf('nc-badge')))
    expect(html.indexOf('rare-badge')).toBeLessThan(html.indexOf('利润</span>', html.indexOf('rare-badge')))
    expect(html).toContain('取消不常考')
  })

  it('无 rootLabel/rootParagraph 时隐藏映射块', () => {
    const html = annotation({ rootLabel: undefined, rootParagraph: undefined })
    expect(html).not.toContain('annotation-root-mapping')
  })

  it('白板面显示 nc × N 与词性；无 nc 不渲染', () => {
    const withNc = renderToStaticMarkup(
      createElement(BoardStage, {
        headword: 'margin',
        phonetic: '',
        showPhonetic: false,
        examples: [],
        exampleCount: 2,
        meanings: [{ pos: 'n.', examples: [] }],
        ncMeanings: [{ pos: 'n.', cn: '边缘' }, { pos: 'n.', cn: '利润' }],
        onSpeak: noop,
        onNext: noop,
      }),
    )
    expect(withNc).toContain('nc × 2')
    expect(withNc).toContain('[n.]')
    expect(withNc).not.toContain('边缘')
    expect(withNc).not.toContain('利润')
    const withoutNc = renderToStaticMarkup(
      createElement(BoardStage, {
        headword: 'margin',
        phonetic: '',
        showPhonetic: false,
        examples: [],
        exampleCount: 2,
        onSpeak: noop,
        onNext: noop,
      }),
    )
    expect(withoutNc).not.toContain('board-nc')
  })

  it('阶段2 映射助记 prop/展示；RootMnemonicDialog 内联反馈；层级 70<80<120', () => {
    const gen = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/components/GenerativeMemoryStage.tsx', import.meta.url)),
      'utf8',
    )
    const dialog = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/components/RootMnemonicDialog.tsx', import.meta.url)),
      'utf8',
    )
    const css = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
      'utf8',
    )
    expect(gen).toContain('rootMnemonicText?: string')
    expect(gen).toContain('映射助记：{rootMnemonicText}')
    expect(studyPage).toContain('rootMnemonicText={rootMnemonicText}')
    expect(dialog).toContain('saveStatus')
    expect(dialog).not.toContain('showToast')
    expect(dialog).toContain('mm-mask--above-generative')
    expect(css).toContain('.mm-mask.mm-mask--above-generative { z-index: 80; }')
    expect(css).toContain('z-index: 70;')
    expect(css).toContain('z-index: 120;')
  })

  it('0.3.61：轻量导出默认、完整备份需确认并显式包含两表', () => {
    const me = readFileSync(
      fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
      'utf8',
    )
    expect(me).toContain('exportMigration(')
    expect(me).toContain('includeDerivationMaps: true, includeContentPacks: true')
    expect(me).toContain('完整备份')
    expect(me).toContain('体积可能很大')
  })

  it('C：不常考按钮在含义行按钮之外（避免嵌套）且可聚焦', () => {
    const html = annotation()
    expect(html).toContain('rare-toggle-btn')
    expect(html).toContain('标记不常考')
    expect(html.indexOf('rare-toggle-btn')).toBeGreaterThan(html.indexOf('</button>'))
    expect(html).not.toContain('role="button" aria-label="取消「利润」')
  })

  it('批量不常考面板在主 AI Dialog 之外且关闭不残留；阶段2 卡片不裁切 CSS', () => {
    const ai = readFileSync(
      fileURLToPath(new URL('../../src/ui/ai/AiGeneratePanel.tsx', import.meta.url)),
      'utf8',
    )
    const css = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
      'utf8',
    )
    // 批量面板是主 Dialog 的 sibling（位于 </Dialog> 之后、放弃草稿 Dialog 之前）
    const panelIndex = ai.indexOf('<RareMeaningsBatchPanel')
    const discardIndex = ai.indexOf('open={discardConfirm}')
    expect(panelIndex).toBeGreaterThan(0)
    expect(panelIndex).toBeLessThan(discardIndex)
    expect(ai.slice(panelIndex - 400, panelIndex)).toContain('RootEtymologyBatchPanel')
    expect(ai).toContain('setRarePanelOpen(false)')
    const card = css.slice(css.indexOf('.generative-wc-card {'), css.indexOf('.generative-wc-card {') + 500)
    expect(card).toContain('box-sizing: border-box')
    expect(card).toContain('padding: 24px 20px')
    expect(card).toContain('overflow: hidden')
    expect(css).toContain('.generative-wc-card .generative-first-paragraph')
    expect(css).toContain('word-break: break-word')
    expect(css).toContain('.batch-derivation')
    const batch = css.slice(css.indexOf('.batch-derivation {'), css.indexOf('.batch-derivation {') + 300)
    expect(batch).toContain('z-index: 80')
  })

  it('A/B：AI 标记入口、预览弹层、批量范围选择', () => {
    const withAi = annotation()
    expect(withAi).toContain('AI 标记不常考')
    expect(studyPage).toContain('generateRareMeanings')
    expect(studyPage).toContain('RareMeaningsPreviewDialog')
    expect(studyPage).toContain('没有需要标记的含义')
    const batchPanelSource = readFileSync(
      fileURLToPath(new URL('../../src/ui/ai/RareMeaningsBatchPanel.tsx', import.meta.url)),
      'utf8',
    )
    expect(batchPanelSource).toContain("'word' | 'today' | 'deck'")
    expect(batchPanelSource).toContain('getRareMarkCandidates')
    expect(batchPanelSource).toContain('筛选后')
    // task-192/194：逐词并发池 + 进度/停止/重试
    expect(batchPanelSource).toContain('generateRareMeaningsBatch')
    expect(batchPanelSource).toContain('onProgress')
    expect(batchPanelSource).toContain('timeoutMs: 30_000')
    expect(batchPanelSource).toContain('retryTimeoutOnce: true')
    expect(batchPanelSource).toContain('signal: controller.signal')
    expect(batchPanelSource).toContain('const stop = () =>')
    // 停止立即恢复 UI
    expect(batchPanelSource).toContain('stopRequestedRef.current = true')
    expect(batchPanelSource).toContain('setRunning(false)\n    setStopped(true)')
    expect(batchPanelSource).toContain('mm-progress')
    expect(batchPanelSource).toContain("await run(retrySources, true)")
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(RareMeaningsBatchPanel, {
          open: true,
          currentWordId: 'deck:margin',
          onClose: noop,
        }),
      ),
    )
    expect(html).toContain('当前词')
    expect(html).toContain('今日计划')
    expect(html).toContain('当前词库')
    expect(html).toContain('并发数')
  })

  it('AI 序号→meaningId 映射；设置 hideRare 开关；StudyPage/助记/hook 接线', () => {
    expect(
      rareMeaningIdsFromIndexes([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [2, 3, 99]),
    ).toEqual(['b', 'c'])
    expect(settingsPage).toContain('记忆时隐藏「不常考」含义')
    // 生成式记忆设置文案与 4 阶段一致
    expect(settingsPage).toContain('阶段 2（居中映射页）需点击累计到该次数后进入阶段 3')
    expect(settingsPage).toContain('阶段 3 每屏显示的含义数量')
    expect(settingsPage).toContain('阶段 2 居中映射页生成元字号')
    expect(settingsPage).toContain('阶段 1/4 显示引申图；阶段 2/3 隐藏')
    expect(settingsPage).not.toContain('阶段 1 需点击页面累计到该次数后进入阶段 2')
    expect(settingsPage).toContain("'study.hideRareMeanings'")
    expect(studyPage).toContain('RootMnemonicDialog')
    expect(studyPage).toContain('getRootMnemonic')
    expect(studyPage).toContain('generateRootMnemonic')
    expect(studyPage).toContain('saveRootMnemonic')
    expect(studyPage).toContain('rareMeaningIds')
    expect(hook).toContain("s['study.hideRareMeanings']")
    expect(hook).toContain('word?.meanings?.map')
  })
})
