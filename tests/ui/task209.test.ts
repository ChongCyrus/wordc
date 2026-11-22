import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { ToastProvider } from '../../src/app/toast'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'
import { RareMeaningsPreviewDialog } from '../../src/ui/study/components/RareMeaningsPreviewDialog'
import {
  RareMeaningsBatchPanel,
  rareCoreBatchFields,
  applyRareBatchSelected,
} from '../../src/ui/ai/RareMeaningsBatchPanel'
import { generativeMeaningsForStage3 } from '../../src/ui/study/lib/generative-meanings'
import { rareBatchApplySummary } from '../../src/ui/study/lib/rare-batch-summary'

const noop = () => undefined
const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)
const settings = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/SettingsPage.tsx', import.meta.url)),
  'utf8',
)

const meaning = {
  meaningId: 'M1',
  pos: '动',
  cn: '谴责',
  familiarity: { clicks: 0, encounters: 0 },
}
const base = {
  headword: 'denounce',
  phonetic: '',
  showPhonetic: false,
  coreSenses: [{ label: '公开宣告' }, { label: '行动举措' }],
  meanings: [meaning, { ...meaning, meaningId: 'M2', cn: '告发' }],
  examples: [],
  mnemonics: [],
  phrases: [],
  showPhrases: false,
  speaking: false,
  onSpeak: noop,
  onMarkMeaning: noop,
}

describe('task-209/210 本义不常考 + 默认隐藏', () => {
  it('设置开关：markRareCoreSenses/hideRareBlocks 默认与文案', () => {
    expect(settings).toContain("'study.markRareCoreSenses'")
    expect(settings).toContain("'study.hideRareBlocks'")
    expect(settings).toContain('AI 标记不常考时也标记本义')
    expect(settings).toContain('隐藏标记为不常考的含义/本义')
    expect(settings).toContain('已有本义标记保留')
  })

  it('注释面默认隐藏 rare c 与本义卡，显示计数；关闭开关则显示+徽标', () => {
    const hidden = renderToStaticMarkup(
      createElement(AnnotationStage, {
        ...base,
        rareMeaningIds: ['M1'],
        rareCoreSenseIndexes: [1],
        hideRareBlocks: true,
        onCancelRareCoreSense: noop,
      } as never),
    )
    expect(hidden).toContain('已隐藏 2 条不常考 · 点此显示')
    expect(hidden).not.toContain('谴责')
    expect(hidden).not.toContain('本义1')
    expect(hidden).not.toContain('取消本义1')

    const shown = renderToStaticMarkup(
      createElement(AnnotationStage, {
        ...base,
        rareMeaningIds: ['M1'],
        rareCoreSenseIndexes: [1],
        hideRareBlocks: false,
        onCancelRareCoreSense: noop,
      } as never),
    )
    expect(shown).toContain('谴责')
    expect(shown).toContain('core-sense-rare-badge')
    expect(shown).toContain('取消本义1「公开宣告」的不常考标记')
    expect(shown).not.toContain('已隐藏 2 条不常考')
  })

  it('临时显示/恢复、生成式阶段3过滤、关闭不清除历史标记', () => {
    const annotationSource = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/components/AnnotationStage.tsx', import.meta.url)),
      'utf8',
    )
    const pageSource = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    expect(annotationSource).toContain('showHiddenRare')
    expect(annotationSource).toContain('已临时显示')
    expect(annotationSource).toContain('点此恢复隐藏')
    expect(pageSource).toContain('hideRareBlocks')
    expect(pageSource).toContain('generativeMeaningsForStage3')
    expect(settings).toContain('study.hideRareBlocks')
  })

  it('批量 core-only mock：本义序号不被 source.coreSenses 缺失过滤，汇总本义计入', () => {
    expect(rareCoreBatchFields([1], undefined)).toEqual({
      rareCoreSenseIndexes: [1],
      rareCoreCns: ['本义1'],
    })
    expect(
      rareCoreBatchFields([1], [{ index: 1, label: '公开宣告' }]),
    ).toEqual({ rareCoreSenseIndexes: [1], rareCoreCns: ['公开宣告'] })
    expect(rareBatchApplySummary(1, 1)).toBe('已应用：含义 1 条 · 本义 1 条')
    const batchSource = readFileSync(
      fileURLToPath(new URL('../../src/ui/ai/RareMeaningsBatchPanel.tsx', import.meta.url)),
      'utf8',
    )
    expect(batchSource).toContain('rareCoreBatchFields(entry.rareCoreSenseIndexes')
    // core 写入不依赖 ids.length>0（core-only 结果也要应用）
    expect(batchSource).toContain('appliedCore += item.rareCoreSenseIndexes?.length ?? 0')
  })

  it('面板 apply 路径：mock core1 同时写入含义+本义，汇总含义1·本义1', async () => {
    const calls = { meanings: [] as string[][], cores: [] as number[][] }
    const result = await applyRareBatchSelected({
      items: [
        {
          wordId: 'deck:denounce',
          headword: 'denounce',
          rareMeaningIndexes: [1],
          rareCns: ['谴责'],
          rareCoreSenseIndexes: [1],
          rareCoreCns: ['公开宣告'],
        },
      ],
      selected: ['deck:denounce'],
      markCoreSenses: true,
      getWord: async () => ({ meanings: [{ id: 'M1' }] }),
      getRareMeaningIds: async () => [],
      setRareMeaningIds: async (_wordId, ids) => {
        calls.meanings.push(ids)
      },
      getRareCoreSenseIndexes: async () => [],
      setRareCoreSenseIndexes: async (_wordId, indexes) => {
        calls.cores.push(indexes)
      },
    })
    expect(result).toEqual({ appliedMeanings: 1, appliedCore: 1 })
    expect(calls.meanings).toEqual([['M1']])
    expect(calls.cores).toEqual([[1]])
    expect(rareBatchApplySummary(result.appliedMeanings, result.appliedCore)).toBe(
      '已应用：含义 1 条 · 本义 1 条',
    )
    const source = readFileSync(
      fileURLToPath(new URL('../../src/ui/ai/RareMeaningsBatchPanel.tsx', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('applyRareMarkResults(')
    expect(source).toContain('item.rareCns.length > 0 || (item.rareCoreCns?.length ?? 0) > 0')
  })

  it('阶段3 rare c 过滤且 nc 不受影响；批量汇总精确区分含义/本义', () => {
    const list = [
      { meaningId: 'M1', cn: '谴责' },
      { meaningId: 'M2', cn: '告发' },
      { meaningId: 'M3', cn: '公开指责' },
    ]
    expect(generativeMeaningsForStage3(list, ['M1'], true).map((item) => item.meaningId)).toEqual(['M2', 'M3'])
    expect(generativeMeaningsForStage3(list, ['M1'], false).map((item) => item.meaningId)).toEqual(['M1', 'M2', 'M3'])
    expect(generativeMeaningsForStage3(list, ['M1', 'M2', 'M3'], true)).toHaveLength(3)
    expect(rareBatchApplySummary(3, 2)).toBe('已应用：含义 3 条 · 本义 2 条')
    const page = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    expect(page).toContain('generativeMeaningsForStage3')
    expect(page).toContain('initialNc={ncMeaningIds}')
  })

  it('当前词预览含本义复选框；批量面板带 markCoreSenses', () => {
    const preview = renderToStaticMarkup(
      createElement(RareMeaningsPreviewDialog, {
        open: true,
        word: 'denounce',
        items: [{ meaningId: 'M1', pos: '动', cn: '谴责' }],
        selected: ['M1'],
        coreItems: [{ coreSenseIndex: 1, label: '公开宣告' }],
        coreSelected: [1],
        onToggle: noop,
        onToggleCore: noop,
        onApply: noop,
        onClose: noop,
      }),
    )
    expect(preview).toContain('本义建议')
    expect(preview).toContain('本义1「公开宣告」')
    expect(preview).toContain('应用已选（含义 1 · 本义 1）')
    const batch = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(RareMeaningsBatchPanel, {
          open: true,
          currentWordId: 'deck:denounce',
          markCoreSenses: true,
          onClose: noop,
        }),
      ),
    )
    expect(batch).toContain('当前词')
    expect(css).toContain('.annotation-hidden-rare')
    expect(css).toContain('.core-sense-rare-badge')
  })
})
