import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoardStage } from '../../src/ui/study/components/BoardStage'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'
import { ActionBar } from '../../src/ui/study/components/ActionBar'
import { CompletionPage } from '../../src/ui/study/components/CompletionPage'
import { StudyTopBar } from '../../src/ui/study/components/StudyTopBar'
import { BackRevertNotice } from '../../src/ui/study/components/BackRevertNotice'
import {
  familiarityBand,
  familiarityPercentLabel,
  familiarityWidthPercent,
} from '../../src/ui/study/lib/familiarity-display'
import type { MeaningView } from '../../src/ui/study/components/types'

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element)
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const example = {
  en: 'A spider spins a web.',
  cn: '蜘蛛结网。',
}

const meaning = (overrides: Partial<MeaningView>): MeaningView => ({
  meaningId: 'w#M1',
  pos: 'n.',
  cn: '蜘蛛',
  clicks: 0,
  encounters: 0,
  familiarity: null,
  ...overrides,
})

describe('学习页 · 白板面', () => {
  it('只显示单词 + 英文例句，不显示中文含义/翻译', () => {
    const html = render(
      createElement(BoardStage, {
        headword: 'spider',
        phonetic: '[ˈspɪdə]',
        showPhonetic: true,
        examples: [example],
        exampleCount: 2,
        onSpeak: () => undefined,
        onNext: () => undefined,
      }),
    )
    expect(html).toContain('spider')
    expect(html).toContain('spins a web.')
    expect(html).toContain('[ˈspɪdə]')
    // 白板面不得出现中文释义/例句翻译
    expect(html).not.toContain('蜘蛛结网')
    expect(html).not.toContain('>蜘蛛<')
    expect(html).toContain('轻点屏幕，回忆释义')
    // 目标词高亮
    expect(html).toContain('class="hl"')
  })

  it('音标缺失时隐藏整行（D33）；showPhonetic=false 时不显示发音按钮', () => {
    const noPhonetic = render(
      createElement(BoardStage, {
        headword: 'spider',
        showPhonetic: true,
        examples: [],
        exampleCount: 2,
        onSpeak: () => undefined,
        onNext: () => undefined,
      }),
    )
    expect(noPhonetic).not.toContain('speak-btn')
    expect(noPhonetic).not.toContain('word-phonetic')

    const hidden = render(
      createElement(BoardStage, {
        headword: 'spider',
        phonetic: '[ˈspɪdə]',
        showPhonetic: false,
        examples: [],
        exampleCount: 2,
        onSpeak: () => undefined,
        onNext: () => undefined,
      }),
    )
    expect(hidden).not.toContain('[ˈspɪdə]')
    expect(hidden).not.toContain('speak-btn')
  })

  it('按 board.exampleCount 截断例句', () => {
    const examples = [
      { en: 'Example one.' },
      { en: 'Example two.' },
      { en: 'Example three.' },
    ]
    const html = render(
      createElement(BoardStage, {
        headword: 'spider',
        showPhonetic: false,
        examples,
        exampleCount: 1,
        onSpeak: () => undefined,
        onNext: () => undefined,
      }),
    )
    expect(html).toContain('Example one.')
    expect(html).not.toContain('Example two.')
  })
})

describe('学习页 · 注释面', () => {
  it('渲染含义行、不熟悉度百分比与条、例句翻译、助记、词组', () => {
    const html = render(
      createElement(AnnotationStage, {
        headword: 'spider',
        phonetic: '[ˈspɪdə]',
        showPhonetic: true,
        meanings: [
          meaning({ meaningId: 'w#M1', cn: '蜘蛛', clicks: 3, encounters: 5, familiarity: 0.6 }),
          meaning({ meaningId: 'w#M2', pos: 'v.', cn: '结网', clicks: 0, encounters: 0, familiarity: null }),
        ],
        examples: [example],
        mnemonics: [{ type: '联想', text: '蜘蛛侠是成功的人' }],
        phrases: [{ en: 'spider web', cn: '蜘蛛网' }],
        showPhrases: true,
        onSpeak: () => undefined,
        onMarkMeaning: () => undefined,
      }),
    )
    expect(html).toContain('蜘蛛')
    expect(html).toContain('结网')
    expect(html).toContain('60%')
    expect(html).toContain('3/5')
    // 0/0 展示 “—”
    expect(html).toContain('—')
    expect(html).toContain('蜘蛛结网。')
    expect(html).toContain('联想')
    expect(html).toContain('蜘蛛侠是成功的人')
    expect(html).toContain('spider web')
    // 不熟悉度条按 60% 落 3 档
    expect(html).toContain('fam-bar fam-bar--3')
    expect(html).toContain('width:60%')
  })

  it('词性标签墨墨化：[名]/[动]/[形]，未知保留原样', () => {
    const html = render(
      createElement(AnnotationStage, {
        headword: 'embrace',
        showPhonetic: false,
        meanings: [
          meaning({ meaningId: 'w#M1', pos: 'vt.', cn: '拥抱' }),
          meaning({ meaningId: 'w#M2', pos: 'n.', cn: '怀抱' }),
          meaning({ meaningId: 'w#M3', pos: 'adj.', cn: '被拥抱的' }),
          meaning({ meaningId: 'w#M4', pos: 'phr.', cn: 'embrace sb' }),
          meaning({ meaningId: 'w#M5', pos: 'abbr.', cn: '缩写用法' }),
        ],
        examples: [],
        mnemonics: [],
        phrases: [],
        showPhrases: true,
        onSpeak: () => undefined,
        onMarkMeaning: () => undefined,
      }),
    )
    expect(html).toContain('class="meaning-pos">[动]</span>拥抱')
    expect(html).toContain('class="meaning-pos">[名]</span>怀抱')
    expect(html).toContain('[形]')
    expect(html).toContain('[词组]')
    // 未知词性保留原样（不加方括号）
    expect(html).toContain('>abbr.</span>缩写用法')
    expect(html).not.toContain('>vt.</span>')
    expect(html).not.toContain('>n.<')
  })

  it('12 个义项 + 长释义：全部渲染、不抛错（滚动/换行交给容器）', () => {
    const meanings = Array.from({ length: 12 }, (_, index) =>
      meaning({
        meaningId: `w#M${index + 1}`,
        pos: index % 2 === 0 ? 'vt.' : 'n.',
        cn: '这是一个比较长的中文释义，用于验证在 375–390 宽度下换行不溢出，最多十二个义项。',
      }),
    )
    const html = render(
      createElement(AnnotationStage, {
        headword: 'embrace',
        showPhonetic: true,
        phonetic: '[ɪmˈbreɪs]',
        meanings,
        examples: [],
        mnemonics: [],
        phrases: [],
        showPhrases: false,
        onSpeak: () => undefined,
        onMarkMeaning: () => undefined,
      }),
    )
    expect(countOccurrences(html, 'class="meaning-row"')).toBe(12)
    expect(countOccurrences(html, '[动]')).toBe(6)
    expect(countOccurrences(html, '[名]')).toBe(6)
  })

  it('记忆入口关闭时隐藏词组（D32）', () => {
    const html = render(
      createElement(AnnotationStage, {
        headword: 'spider',
        showPhonetic: false,
        meanings: [meaning({})],
        examples: [],
        mnemonics: [],
        phrases: [{ en: 'spider web', cn: '蜘蛛网' }],
        showPhrases: false,
        onSpeak: () => undefined,
        onMarkMeaning: () => undefined,
      }),
    )
    expect(html).not.toContain('蜘蛛网')
    expect(html).not.toContain('词组')
  })
})

describe('学习页 · 记忆 w-c 页', () => {
  it('大卡显示 w → c、当前/总次数、点阵；无词组数据时不渲染词组块', () => {
    const html = render(
      createElement(MemoryStage, {
        headword: 'spider',
        meaningCn: '蜘蛛',
        count: 2,
        total: 3,
        phraseLines: [],
        showPhrases: true,
        fontScale: 1,
        cardSize: 1,
        onTap: () => undefined,
      }),
    )
    expect(html).toContain('spider')
    expect(html).toContain('蜘蛛')
    expect(html).toContain('2 / 3')
    expect(countOccurrences(html, 'wc-dot is-filled')).toBe(2)
    expect(countOccurrences(html, 'class="wc-dot"')).toBe(1)
    expect(html).not.toContain('wc-phrases')
    expect(html).toContain('--wc-card-size:1')
  })

  it('字号受 fontScale 影响；词组开关开启且有数据时显示词组', () => {
    const html = render(
      createElement(MemoryStage, {
        headword: 'spider',
        meaningCn: '蜘蛛',
        count: 0,
        total: 3,
        phraseLines: [{ en: 'spider web', cn: '蜘蛛网' }],
        showPhrases: true,
        fontScale: 1.2,
        cardSize: 1.1,
        onTap: () => undefined,
      }),
    )
    // 36 * 1.2 = 43.2 → 43px
    expect(html).toContain('--wc-word-size:43px')
    // 34 * 1.2 = 40.8 → 41px
    expect(html).toContain('--wc-cn-size:41px')
    expect(html).toContain('spider web — 蜘蛛网')
    expect(html).toContain('轻点屏幕，记忆一次')
  })

  it('词组开关关闭时即使有数据也不显示', () => {
    const html = render(
      createElement(MemoryStage, {
        headword: 'spider',
        meaningCn: '蜘蛛',
        count: 1,
        total: 3,
        phraseLines: [{ en: 'spider web', cn: '蜘蛛网' }],
        showPhrases: false,
        fontScale: 1,
        cardSize: 1,
        onTap: () => undefined,
      }),
    )
    expect(html).not.toContain('蜘蛛网')
  })
})

describe('学习页 · 操作区与完成页', () => {
  it('三键文案正确、记忆按钮存在；锁定时三键 disabled', () => {
    const html = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
        ratingDisabled: true,
      }),
    )
    expect(html).toContain('记忆')
    expect(html).toContain('认识')
    expect(html).toContain('模糊')
    expect(html).toContain('不认识')
    expect(countOccurrences(html, 'disabled=""')).toBe(3)
  })

  it('记忆按钮永不禁用（可重复进入/重开 w-c）', () => {
    const html = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
        ratingDisabled: false,
      }),
    )
    expect(html).not.toContain('memory-btn" disabled')
    // 记忆按钮不带 disabled 属性
    const memoryButton = html.split('class="memory-btn"')[1]?.slice(0, 60) ?? ''
    expect(memoryButton).not.toContain('disabled')
  })

  it('三键下方显示「下次出现」副标题（12px 小字，不破坏布局）', () => {
    const html = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
        nextHints: {
          familiar: '78 天后',
          vague: '今日 · 3 天后',
          forgot: '今日 · 明天',
        },
      }),
    )
    expect(html).toContain('78 天后')
    expect(html).toContain('今日 · 3 天后')
    expect(html).toContain('今日 · 明天')
    expect(countOccurrences(html, 'class="rating-sub"')).toBe(3)
    expect(html).toContain('aria-label="认识，78 天后"')
  })

  it('主标签可切换：首次「认识/不确定/不认识」、之后「认识/模糊/忘记」', () => {
    const first = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
        labels: { familiar: '认识', vague: '不确定', forgot: '不认识' },
      }),
    )
    expect(first).toContain('不确定')
    expect(first).toContain('不认识的'.slice(0, 3))

    const later = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
        labels: { familiar: '认识', vague: '模糊', forgot: '忘记' },
      }),
    )
    expect(later).toContain('模糊')
    expect(later).toContain('忘记')
    expect(later).not.toContain('不确定')
  })

  it('回退浏览时高亮「上次选择」对应的评分键', () => {
    const html = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
        highlighted: 'vague',
      }),
    )
    expect(countOccurrences(html, 'is-previous')).toBe(1)
    // 高亮必须在「模糊」按钮上
    const vagueButton = html.slice(html.indexOf('rating-btn rating-btn--vague'))
    expect(vagueButton.slice(0, 80)).toContain('is-previous')

    const none = render(
      createElement(ActionBar, { onMemory: () => undefined, onRate: () => undefined }),
    )
    expect(none).not.toContain('is-previous')
  })

  it('未提供预览时三键不渲染副标题（降级布局）', () => {
    const html = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
      }),
    )
    expect(html).not.toContain('rating-sub')
  })

  it('完成页显示学习数量与用时，并给出统计/首页入口', () => {
    const html = render(
      createElement(CompletionPage, {
        variant: 'done',
        learnedCount: 52,
        minutes: 18,
        onPrimary: () => undefined,
        onSecondary: () => undefined,
      }),
    )
    expect(html).toContain('今日任务完成！')
    expect(html).toContain('学习 52 个 · 用时 18 分钟')
    expect(html).toContain('查看统计')
    expect(html).toContain('回首页')
  })

  it('无词库空状态给出「去添加词库」入口', () => {
    const html = render(
      createElement(CompletionPage, {
        variant: 'no-deck',
        onPrimary: () => undefined,
        onSecondary: () => undefined,
      }),
    )
    expect(html).toContain('还没有词库')
    expect(html).toContain('去添加词库')
  })
})

describe('学习页 · 回退框架（task-30）', () => {
  it('顶栏：传 onBack 时显示 `<`（上一个单词），退出按钮移到右侧；不传时保持原布局', () => {
    const withBack = render(
      createElement(StudyTopBar, {
        title: '3 / 50',
        progress: 0.06,
        onClose: () => undefined,
        onMenu: () => undefined,
        onBack: () => undefined,
      }),
    )
    expect(withBack).toContain('aria-label="上一个单词"')
    expect(countOccurrences(withBack, 'study-icon-btn')).toBe(3)
    expect(countOccurrences(withBack, 'aria-label="退出学习"')).toBe(1)

    const noBack = render(
      createElement(StudyTopBar, {
        title: '3 / 50',
        progress: 0.06,
        onClose: () => undefined,
        onMenu: () => undefined,
      }),
    )
    expect(noBack).not.toContain('上一个单词')
    expect(countOccurrences(noBack, 'study-icon-btn')).toBe(2)
  })

  it('回退改判提示条（task-44）：明显提示 + 「改判」文案 + 「不改了，继续」按钮', () => {
    const html = render(
      createElement(BackRevertNotice, { rating: 'vague', onContinue: () => undefined }),
    )
    expect(html).toContain('back-revert-notice')
    expect(html).toContain('正在回看上一词')
    expect(html).toContain('上次选择「模糊」')
    expect(html).toContain('改判')
    expect(html).toContain('不改了，继续')

    const forgot = render(
      createElement(BackRevertNotice, { rating: 'forgot', onContinue: () => undefined }),
    )
    expect(forgot).toContain('上次选择「忘记」')

    const unknown = render(
      createElement(BackRevertNotice, { rating: null, onContinue: () => undefined }),
    )
    expect(unknown).toContain('正在回看上一词')
    expect(unknown).not.toContain('上次选择')
  })

  it('白板面各 c 英文词组开关（F7）：开启按 meaningId 过滤且不显示中文；关闭不渲染', () => {
    const props = {
      headword: 'bank',
      phonetic: '',
      showPhonetic: false,
      examples: [],
      exampleCount: 2,
      meanings: [{ pos: 'n.', examples: [], meaningId: 'w#M1' }],
      phrases: [
        { en: 'river bank', meaningId: 'w#M1' },
        { en: 'bank account', meaningId: 'w#M2' },
      ],
      onSpeak: () => undefined,
      onNext: () => undefined,
    }
    const on = render(createElement(BoardStage, { ...props, showMeaningPhrases: true }))
    expect(on).toContain('river bank')
    expect(on).not.toContain('bank account')
    expect(on).not.toContain('河岸')
    expect(on).toContain('board-meaning-phrase')

    const off = render(createElement(BoardStage, { ...props, showMeaningPhrases: false }))
    expect(off).not.toContain('river bank')
  })

  it('白板面各 c 词性 + 英文例句，不泄露中文（F4）', () => {
    const html = render(
      createElement(BoardStage, {
        headword: 'bank',
        phonetic: '',
        showPhonetic: false,
        examples: [],
        exampleCount: 2,
        meanings: [
          { pos: 'n.', examples: [{ en: 'the river bank', cn: '河岸' }] },
          { pos: 'n.', examples: [{ en: 'a bank account', cn: '银行账户' }] },
        ],
        onSpeak: () => undefined,
        onNext: () => undefined,
      }),
    )
    expect(html).toContain('the river bank')
    expect(html).toContain('a bank account')
    expect(html).toContain('board-meanings')
    expect(html).not.toContain('河岸')
    expect(html).not.toContain('银行账户')
  })

  it('w-c 当前 c 信息区（F1）：例句/助记/不熟悉度条+排名渲染，点击不触发 onTap 区域标记', () => {
    const html = render(
      createElement(MemoryStage, {
        headword: 'bank',
        meaningCn: '银行',
        count: 1,
        total: 3,
        phraseLines: [],
        showPhrases: false,
        fontScale: 1,
        cardSize: 1,
        onTap: () => undefined,
        examples: [{ en: 'I went to the bank.', cn: '我去了银行。' }],
        mnemonics: [{ type: '联想', text: 'bank 河岸→银行' }],
        familiarity: 0.4,
        unfamiliarityRank: { rank: 2, total: 5 },
      }),
    )
    expect(html).toContain('I went to the bank.')
    expect(html).toContain('我去了银行。')
    expect(html).toContain('bank 河岸→银行')
    expect(html).toContain('不熟悉度 40%')
    expect(html).toContain('第 2 / 5 不熟悉')
    expect(html).toContain('wc-info')
  })

  it('加权记忆按钮（F2）：传入 onWeightedMemory 时与「记忆」并排；缺省不渲染', () => {
    const withWeighted = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onWeightedMemory: () => undefined,
        onRate: () => undefined,
      }),
    )
    expect(withWeighted).toContain('记忆')
    expect(withWeighted).toContain('加权记忆')
    expect(withWeighted).toContain('memory-row')

    const normal = render(
      createElement(ActionBar, { onMemory: () => undefined, onRate: () => undefined }),
    )
    expect(normal).not.toContain('加权记忆')
  })

  it('回退时提示条位于操作区三键上方（ActionBar notice 插槽）；非回退不渲染', () => {
    const browsing = render(
      createElement(ActionBar, {
        onMemory: () => undefined,
        onRate: () => undefined,
        notice: createElement(BackRevertNotice, {
          rating: 'vague',
          onContinue: () => undefined,
        }),
      }),
    )
    expect(browsing).toContain('back-revert-notice')
    expect(browsing.indexOf('back-revert-notice')).toBeLessThan(browsing.indexOf('memory-btn'))

    const normal = render(
      createElement(ActionBar, { onMemory: () => undefined, onRate: () => undefined }),
    )
    expect(normal).not.toContain('back-revert-notice')
  })
})

describe('不熟悉度展示映射（5 档 / 宽度 / 文案）', () => {
  it('null（从未遇到）→ 无档、0 宽、显示 —', () => {
    expect(familiarityBand(null)).toBeNull()
    expect(familiarityWidthPercent(null)).toBe(0)
    expect(familiarityPercentLabel(null)).toBe('—')
  })

  it('按 20% 分档，clamp 到 [0,1]', () => {
    expect(familiarityBand(0)).toBe(0)
    expect(familiarityBand(0.19)).toBe(0)
    expect(familiarityBand(0.2)).toBe(1)
    expect(familiarityBand(0.4)).toBe(2)
    expect(familiarityBand(0.6)).toBe(3)
    expect(familiarityBand(0.8)).toBe(4)
    expect(familiarityBand(1)).toBe(4)
    expect(familiarityBand(3)).toBe(4)
    expect(familiarityBand(-1)).toBe(0)
  })

  it('宽度：f=0 不填充，>0 至少 2%', () => {
    expect(familiarityWidthPercent(0)).toBe(0)
    expect(familiarityWidthPercent(0.005)).toBe(2)
    expect(familiarityWidthPercent(0.6)).toBeCloseTo(60)
  })

  it('百分比取整文案', () => {
    expect(familiarityPercentLabel(2 / 3)).toBe('67%')
    expect(familiarityPercentLabel(1)).toBe('100%')
  })
})
