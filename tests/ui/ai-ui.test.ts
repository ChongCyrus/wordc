import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AI_ERROR_MESSAGES,
  AI_SCOPE_OPTIONS,
  aiErrorMessage,
  aiKindLabel,
  aiScopeLabel,
  formatDeckOption,
  AI_FAILURE_LABELS,
  pickAiFailureMessage,
  summarizeAiFailures,
  formatAiBudget,
  formatAiProgress,
  formatAiSummary,
  AI_EMPTY_TARGET_MESSAGE,
  AI_GENERATION_TIMEOUT_MS,
  AI_MODE_OPTIONS,
  AI_SEMANTICS_MODE_OPTIONS,
  aiModeLabel,
  withAiTimeout,
  formatAiTestFailure,
} from '../../src/app/hooks/aiUi'
import { AiGenerateView, itemLines } from '../../src/ui/ai/AiGeneratePanel'
import { AiReviewDialog } from '../../src/ui/ai/AiGeneratePanel'
import { AiSettingsForm } from '../../src/ui/me/AiSettingsSection'

const noop = () => undefined

describe('AI 扩充 UI（task-71）', () => {
  it('错误码文案：12 类全覆盖，Key 相关不泄露明文', () => {
    const codes = Object.keys(AI_ERROR_MESSAGES)
    expect(codes).toHaveLength(13)
    for (const code of codes) {
      const message = aiErrorMessage(code)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toMatch(/sk-[A-Za-z0-9]{6,}/)
    }
    expect(aiErrorMessage('AI_AUTH')).toContain('Key 无效')
    expect(aiErrorMessage('AI_AUTH')).toContain('HTTP 401')
    expect(aiErrorMessage('AI_QUOTA')).toContain('HTTP 402')
    expect(aiErrorMessage('AI_RATE_LIMIT')).toContain('HTTP 429')
    expect(aiErrorMessage('AI_RATE_LIMIT')).toContain('频繁')
    expect(aiErrorMessage('AI_CANCELED')).toContain('取消')
    expect(aiErrorMessage('UNKNOWN' as never, '兜底')).toBe('兜底')
  })

  it('semantics 审核展示（task-85 骨架）：本义集合 + c 归属/链', () => {
    const lines = itemLines('semantics', {
      headword: 'workshop',
      coreSenses: [{ index: 1, label: '车间', confidence: 'high' }],
      meaningMap: [{ meaningIndex: 2, coreSenseIndex: 1, steps: ['车间', '研讨会'] }],
    } as never)
    expect(lines.join('\n')).toContain('本义1 「车间」')
    expect(lines.join('\n')).toContain('c2 → 本义1：车间 → 研讨会')
  })

  it('deck 选项不重复词数（S20 P3）', () => {
    expect(formatDeckOption('2025考研英语词汇受限商业词表（6702 词）', 6702)).toBe(
      '2025考研英语词汇受限商业词表（6702 词）',
    )
    expect(formatDeckOption('QA空词库', 0)).toBe('QA空词库（0 词）')
  })

  it('助记审核显示「cX 中文 → 助记」（task-128）', () => {
    const lines = itemLines(
      'mnemonics',
      {
        headword: 'bank',
        meaningIndex: 2,
        mnemonics: [{ type: '联想', text: 'bank 河岸→银行' }],
      } as never,
      { meanings: [{ cn: '银行' }, { cn: '河岸' }] },
    )
    expect(lines[0]).toContain('c2 河岸 → [联想] bank 河岸→银行')
  })

  it('失败分类计数汇总（13 类；S18 P2）', () => {
    expect(summarizeAiFailures(['AI_QUOTA', 'AI_QUOTA', 'AI_RATE_LIMIT'])).toBe(
      '失败 3 条：余额不足 2、请求过于频繁 1',
    )
    expect(summarizeAiFailures(['AI_TIMEOUT'])).toContain('请求超时 1')
    expect(summarizeAiFailures([])).toBeNull()
    for (const code of Object.keys(AI_FAILURE_LABELS)) {
      const summary = summarizeAiFailures([code])
      expect(summary).toContain(AI_FAILURE_LABELS[code as keyof typeof AI_FAILURE_LABELS])
    }
    expect(summarizeAiFailures(['AI_QUOTA'])).toContain('余额不足')
    expect(summarizeAiFailures(['AI_RATE_LIMIT'])).toContain('请求过于频繁')
    expect(summarizeAiFailures(['AI_TIMEOUT'])).toContain('请求超时')
  })

  it('批量失败码 → 分类文案（402/429/408；S18 P2）', () => {
    expect(pickAiFailureMessage(['AI_QUOTA'])).toContain('余额不足')
    expect(pickAiFailureMessage([undefined, 'AI_RATE_LIMIT'])).toContain('请求过于频繁')
    expect(pickAiFailureMessage(['AI_TIMEOUT'])).toContain('请求超时')
    // 关键码优先于普通码
    expect(pickAiFailureMessage(['AI_FORMAT', 'AI_AUTH'])).toContain('Key 无效')
    expect(pickAiFailureMessage([])).toBeNull()
  })

  it('范围/类型标签与预算、进度、汇总格式化', () => {
    expect(AI_SCOPE_OPTIONS.map((option) => option.value)).toEqual([
      'today',
      'deck',
      'word',
      'meanings',
      'deck-select',
      'custom',
    ])
    expect(aiScopeLabel('today')).toBe('今日要学')
    expect(aiKindLabel('examples')).toBe('例句')
    expect(formatAiBudget(0.12, 3)).toBe('预计 ¥0.12 / 单次上限 ¥3.00')
    expect(formatAiBudget(0.5, 0)).toContain('不限')
    expect(formatAiProgress(12, 40, 0.08)).toBe('正在生成 12 / 40 · 已用 ¥0.08')
    expect(
      formatAiSummary({ total: 10, succeeded: 8, failed: 2, canceled: false, costYuan: 0.2 }),
    ).toContain('完成 8 / 10 条，失败 2 条')
    expect(
      formatAiSummary({ total: 10, succeeded: 3, failed: 7, canceled: true, costYuan: 0.1 }),
    ).toContain('已取消')
  })

  it('AI 设置表单：provider/Key 掩码/存储方式/预算/隐私说明/操作按钮', () => {
    const html = renderToStaticMarkup(
      createElement(AiSettingsForm, {
        value: {
          enabled: true,
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          keyStorage: 'persistent',
          maskedKey: 'sk-…abcd',
          hasKey: true,
          maxCostPerRun: 3,
          pregenBudget: 40,
          jsonMode: true,
        },
        onChange: noop,
        onSaveKey: noop,
        onClearKey: noop,
        onToggleEnabled: noop,
        onToggleJsonMode: noop,
        onTestConnection: noop,
        testing: false,
        testMessage: null,
      }),
    )
    expect(html).toContain('启用 AI 扩充')
    expect(html).toContain('DeepSeek（默认）')
    expect(html).toContain('API Key')
    expect(html).toContain('sk-…abcd')
    expect(html).toContain('Key 存储方式')
    expect(html).toContain('保存 Key')
    expect(html).toContain('测试连接')
    expect(html).toContain('单次运行费用上限')
    expect(html).toContain('全量预生成预算')
    expect(html).toContain('JSON 模式')
    expect(html).toContain('免费模型')
    expect(html).toContain('不会导出/不上传/不写日志')
    expect(html).toContain('role="switch"')
  })

  it('task-109：无目标文案/60s UI 超时/取消不转圈', async () => {
    expect(AI_EMPTY_TARGET_MESSAGE).toBe('没有可生成的词（已有/被排除）')
    expect(AI_GENERATION_TIMEOUT_MS).toBe(60_000)
    let timedOut = false
    await expect(
      withAiTimeout(new Promise(() => undefined), { timeoutMs: 5, onTimeout: () => { timedOut = true } }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
    expect(timedOut).toBe(true)
    await expect(withAiTimeout(Promise.resolve('ok'), { timeoutMs: 500 })).resolves.toBe('ok')
  })

  it('task-107/108：生成模式标签与指定含义选项', () => {
    expect(AI_MODE_OPTIONS.map((option) => option.value)).toEqual(['missing', 'append', 'replace'])
    expect(AI_SEMANTICS_MODE_OPTIONS.map((option) => option.value)).toEqual(['missing', 'replace'])
    expect(aiModeLabel('append')).toBe('追加更多')
    expect(aiScopeLabel('meanings')).toBe('指定含义')
  })

  it('task-117：测试连接失败文案带底层原因', () => {
    expect(formatAiTestFailure('AI_TIMEOUT')).toContain('请求超时')
    expect(formatAiTestFailure('AI_NETWORK', 'UnknownHostException: api.deepseek.com')).toContain('UnknownHostException')
    expect(formatAiTestFailure(undefined, '401')).toContain('401')
    expect(formatAiTestFailure('AI_NETWORK')).not.toContain('（')
  })

  it('task-107/108 面板：指定含义多选 + 生成模式控件', () => {
    const base = {
      scope: 'meanings' as const,
      kinds: ['examples' as const, 'semantics' as const],
      excludes: ['rejected' as const],
      targetCount: 2,
      estimateText: '',
      budgetText: '',
      progress: null,
      summary: null,
      error: null,
      running: false,
      onScope: noop,
      onToggleKind: noop,
      onToggleExclude: noop,
      onStart: noop,
      onCancel: noop,
      onClose: noop,
    }
    const html = renderToStaticMarkup(
      createElement(AiGenerateView, {
        ...base,
        modes: { examples: 'replace', semantics: 'replace' },
        wordMeanings: [
          { index: 1, cn: '苹果', pos: 'n.' },
          { index: 2, cn: '苹果树' },
        ],
        selectedMeaningIndexes: [1],
      }),
    )
    expect(html).toContain('指定含义')
    expect(html).toContain('选择含义（可多选）')
    expect(html).toContain('c1')
    expect(html).toContain('生成模式（按类型）')
    expect(html).toContain('覆盖')
    expect(html).toContain('替换该词本义')
  })

  it('生成面板：范围/类型/排除/预算/开始按钮；运行中显示取消与进度', () => {
    const base = {
      scope: 'today' as const,
      kinds: ['examples' as const],
      excludes: ['existingExamples' as const, 'rejected' as const],
      targetCount: 12,
      estimateText: '预计 ¥0.12 / 单次上限 ¥3.00',
      budgetText: '单次上限 ¥3.00',
      progress: null,
      summary: null,
      error: null,
      onScope: noop,
      onToggleKind: noop,
      onToggleExclude: noop,
      onStart: noop,
      onCancel: noop,
      onClose: noop,
    }
    const idle = renderToStaticMarkup(
      createElement(AiGenerateView, { ...base, running: false }),
    )
    expect(idle).toContain('今日要学')
    expect(idle).toContain('当前词库')
    expect(idle).toContain('例句')
    expect(idle).toContain('已有例句')
    expect(idle).toContain('已拒绝')
    expect(idle).toContain('目标：12 个词/含义')
    expect(idle).toContain('开始生成')
    expect(idle).toContain('本次生成上限')
    expect(idle).not.toContain('没有可生成的词')

    const semanticsIdle = renderToStaticMarkup(
      createElement(AiGenerateView, { ...base, running: false, kinds: ['semantics'], targetCount: 0 }),
    )
    expect(semanticsIdle).toContain('本义链仅对多含义词生成')
    expect(semanticsIdle).toContain('没有可生成的词')

    const running = renderToStaticMarkup(
      createElement(AiGenerateView, {
        ...base,
        running: true,
        progress: { done: 3, total: 12, costYuan: 0.05 },
        error: '请求过于频繁',
      }),
    )
    expect(running).toContain('正在生成 3 / 12')
    expect(running).toContain('取消生成')
    expect(running).toContain('请求过于频繁')
  })

  it('审核对话框：✓/❌、全选、保存已选；未接落库时禁用保存', () => {
    const items = [
      { key: 'a', headword: 'embrace', kindLabel: '例句', lines: ['She embraced him. — 她拥抱了他。'] },
      { key: 'b', headword: 'abandon', kindLabel: '助记', lines: ['[assoc] 联想'] },
    ]
    const html = renderToStaticMarkup(
      createElement(AiReviewDialog, {
        open: true,
        items,
        selected: new Set<string>(['a', 'b']),
        canApply: true,
        onToggle: noop,
        onToggleAll: noop,
        onApply: noop,
        onReject: noop,
        onClose: noop,
      }),
    )
    expect(html).toContain('审核生成内容（2）')
    expect(html).toContain('embrace · 例句')
    expect(html).toContain('全不选')
    expect(html).toContain('保存已选（2）')
    expect(html).toContain('❌')
    expect(html).toContain('✓ 选中后保存到本地词库')

    const blocked = renderToStaticMarkup(
      createElement(AiReviewDialog, {
        open: true,
        items,
        selected: new Set<string>(),
        canApply: false,
        onToggle: noop,
        onToggleAll: noop,
        onApply: noop,
        onReject: noop,
        onClose: noop,
      }),
    )
    expect(blocked).toContain('落库接口尚未接通')
  })
})

describe('AI 面板挂载顺序（S20 P1 回归）', () => {
  it('AiGeneratePanel 内不得在 hooks（useEffect 等）之前早退（React #310）', async () => {
    // @ts-expect-error 项目未装 @types/node；仅 node 测试读取源码
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      new URL('../../src/ui/ai/AiGeneratePanel.tsx', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('export function AiGeneratePanel')
    const region = source.slice(start, source.indexOf('\nfunction ', start + 10))
    expect(region).not.toContain('if (!open) return null')
    // 内层 Dialog 用 open 控制可见性，hooks 顺序恒定
    expect(region).toContain('useEffect')
  })
})
