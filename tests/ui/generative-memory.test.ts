import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import {
  GenerativeMemoryStage,
  extractRootParagraph,
} from '../../src/ui/study/components/GenerativeMemoryStage'
import { ActionBar } from '../../src/ui/study/components/ActionBar'
import {
  clampGenerativeSettings,
  DEFAULT_GENERATIVE_SETTINGS,
  readGenerativeSettings,
} from '../../src/app/hooks/generativeSettings'

const noop = () => undefined
const meanings = [
  { meaningId: 'm1', pos: 'n.', cn: '边缘', examples: [{ en: 'the margin', cn: '边缘' }] },
  { meaningId: 'm2', pos: 'n.', cn: '利润', examples: [{ en: 'profit margin', cn: '利润率' }] },
  { meaningId: 'm3', pos: 'n.', cn: '余地', examples: [] },
]

function stage(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(GenerativeMemoryStage, {
      open: true,
      word: 'margin',
      rootLabel: '边缘',
      text: '本义/核心义：边缘\n\n- 边缘 → 边缘的',
      mermaid: 'mindmap\n  root((边缘))',
      showMermaid: true,
      rootFontScale: 1,
      clicksRequired: 3,
      perScreen: 2,
      meanings,
      initialNc: [],
      onEditRootMnemonic: noop,
      onSaveNc: noop,
      onClose: noop,
      ...props,
    } as never),
  )
}

describe('B 生成式记忆（task-167）', () => {
  it('ActionBar 在记忆与加权记忆之间显示生成式记忆', () => {
    const html = renderToStaticMarkup(
      createElement(ActionBar, {
        onMemory: noop,
        onWeightedMemory: noop,
        onGenerativeMemory: noop,
        onRate: noop,
      }),
    )
    expect(html).toContain('生成式记忆')
    const memory = html.indexOf('记忆')
    const gen = html.indexOf('生成式记忆')
    const weighted = html.indexOf('加权记忆')
    expect(memory).toBeLessThan(gen)
    expect(gen).toBeLessThan(weighted)
  })

  it('阶段 1：提示/单词→生成元/文字/Mermaid/计数', () => {
    const html = stage()
    expect(html).toContain('请记忆单词到生成元的映射')
    expect(html).toContain('margin → 边缘')
    expect(html).toContain('边缘 → 边缘的')
    expect(html).toContain('mindmap')
    expect(html).toContain('下一步')
    expect(html).not.toContain('已点 0 / 3 次')
  })

  it('阶段2：居中 w↓生成元 + 文字第一段，点击计数；阶段3/4 标题与文案', () => {
    const phase2 = stage({ initialPhase: 2 })
    expect(phase2).toContain('阶段 2/4')
    expect(phase2).toContain('margin')
    expect(phase2).toContain('边缘')
    expect(phase2).toContain('本义/核心义：边缘')
    expect(phase2).toContain('0 / 3')
    expect(phase2).toContain('AI助记·生成元映射')
    // task-197 微调：垂直居中 + 复用 w-c 卡片结构
    expect(phase2).toContain('generative-phase2')
    expect(phase2).toContain('generative-phase2-body')
    expect(phase2).toContain('wc-card')
    expect(phase2).toContain('wc-word')
    expect(phase2).toContain('wc-arrow')
    expect(phase2).toContain('wc-cn')
    expect(phase2).toContain('generative-count')
    expect(phase2).toContain('wc-count-row')
    expect(phase2).toContain('0 / 3')
    expect((phase2.match(/class="wc-dot"/g) ?? []).length).toBe(3)
    expect((phase2.match(/wc-dot is-filled/g) ?? []).length).toBe(0)
    // 卡片外按钮区在卡片之后（点击卡片不触发按钮）
    expect(phase2.indexOf('generative-wc-card')).toBeLessThan(phase2.indexOf('generative-phase2-actions'))

    const phase3 = stage({ initialPhase: 3, initialNc: ['m1'] })
    expect(phase3).toContain('阶段 3/4')
    expect(phase3).toContain('代入生成元到各个实际含义的例句')
    expect(phase3).toContain('下一步')

    const phase4 = stage({ initialPhase: 4, initialNc: ['m1'] })
    expect(phase4).toContain('阶段 4/4')
    expect(phase4).toContain('请记忆、默背下述生成元到各实际含义（尤其是 nc）的引申关系')
    expect(phase4).toContain('完成')

    expect(extractRootParagraph('本义/核心义：边缘\n\n- 其他')).toBe('本义/核心义：边缘')
    expect(extractRootParagraph('- 本义：河岸\n第二段')).toBe('本义：河岸')
    expect(extractRootParagraph('')).toBe('')
  })

  it('阶段 3：代入例句找 nc，默认已有 nc 选中、显示例句与分页', () => {
    const html = stage({ initialPhase: 3, initialNc: ['m1'] })
    expect(html).toContain('代入生成元到各个实际含义的例句')
    expect(html).toContain('the margin')
    expect(html).toContain('边缘')
    expect(html).toContain('第 1 / 2 屏')
    expect(html).toContain('nc')
    expect(html).toContain('下一步')
  })

  it('阶段 4：关系网络、nc 列表、完成', () => {
    const html = stage({ initialPhase: 4, initialNc: ['m1', 'm2'] })
    expect(html).toContain('请记忆、默背下述生成元到各实际含义（尤其是 nc）的引申关系')
    expect(html).toContain('完成')
    expect(html).toContain('边缘')
    expect(html).toContain('利润')
  })

  it('阶段2只内容空白区计数，按钮/Mermaid/保存反馈（task-182/197）', () => {
    const html = stage({ initialPhase: 2 })
    expect(html).toContain('generative-tap-zone')
    const src = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/components/GenerativeMemoryStage.tsx', import.meta.url)),
      'utf8',
    )
    expect(src).not.toContain('generative-scroll" onClick={tap}')
    expect(src).toContain('generative-tap-zone')
    // 阶段2 整屏非按钮区域计数
    expect(src).toContain('handlePhase2Click')
    expect(src).toContain('closest(\'button,a,input,textarea,select,[role="button"]\')')
    expect(src).toContain('className="generative-scroll generative-phase2" onClick={handlePhase2Click}')
    expect(src).toContain('generative-tap-zone')
    // 阶段2 整屏非按钮区域计数
    expect(src).toContain('handlePhase2Click')
    expect(src).toContain('closest(\'button,a,input,textarea,select,[role="button"]\')')
    expect(src).toContain('className="generative-scroll generative-phase2" onClick={handlePhase2Click}')

    const withStatus = stage({ saveStatus: '已保存引申图' })
    expect(withStatus).toContain('generative-feedback')
    expect(withStatus).toContain('已保存引申图')
  })

  it('阶段切换不被 nc 保存（initialNc 变化）重置（task-180）', () => {
    // 源码级回归：重置 effect 依赖不得包含 initialNc
    const src = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/components/GenerativeMemoryStage.tsx', import.meta.url)),
      'utf8',
    )
    expect(src).toContain('}, [open, word, initialPhase])')
    expect(src).not.toContain('initialNc, initialPhase]')
    expect(src).toContain('setPhase(3)')
    // 阶段 4 显示关系提示而非阶段 1 占位
    const phase4 = stage({ initialPhase: 4, initialNc: ['m1'] })
    expect(phase4).toContain('请记忆、默背下述生成元到各实际含义（尤其是 nc）的引申关系')
    expect(phase4).not.toContain('请记忆单词到生成元的映射')
  })

  it('打开生成式记忆时自动收起右页（task-180）', () => {
    const pageSrc = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    const handler = pageSrc.slice(pageSrc.indexOf('onGenerativeMemory='), pageSrc.indexOf('onMemory={') > 0 ? pageSrc.indexOf('onGenerativeMemory=') + 500 : undefined)
    expect(handler).toContain('setDerivationPanelOpen(false)')
    expect(handler).toContain('setGenerativeOpen(true)')
  })

  it('设置默认/边界', () => {
    expect(DEFAULT_GENERATIVE_SETTINGS).toEqual({ clicks: 3, perScreen: 2, rootFontScale: 1, showMermaid: true })
    expect(clampGenerativeSettings({ clicks: 0, perScreen: 9, rootFontScale: 3 }).clicks).toBe(1)
    expect(clampGenerativeSettings({ perScreen: 9 }).perScreen).toBe(5)
    expect(clampGenerativeSettings({ rootFontScale: 3 }).rootFontScale).toBe(1.6)
    expect(clampGenerativeSettings({ showMermaid: false }).showMermaid).toBe(false)
    expect(readGenerativeSettings()).toEqual(DEFAULT_GENERATIVE_SETTINGS)
  })
})
