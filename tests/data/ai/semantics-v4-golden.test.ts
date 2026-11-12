/**
 * task-96 · v4 golden cases（plan / base / abstract / tunnel）
 *
 * 数据来自 docs/SEMANTICS-FORMAT.md §4 的期望输出；用 dev-data 的
 * `validateSemanticsV4Items()` 校验：合法输入必须通过、结构不变量必须被满足。
 * 反向用例覆盖用户截图里的真实缺陷（label 写成检查步骤/词源、origin 无解释、缺映射、孤儿本义）。
 */
import { describe, expect, it } from 'vitest'
import { validateSemanticsV4Items } from '../../../src/data/ai/semantics'

const planMeanings = [
  { cn: 'n. 计划；方案' },
  { cn: 'n. 平面图；示意图' },
  { cn: 'v. 计划；打算' },
  { cn: 'v. 设计；绘制平面图' },
]
const baseMeanings = [
  { cn: 'n. 基础；基底' },
  { cn: 'n. 底部；底座' },
  { cn: 'n. 基地；根据地' },
  { cn: 'adj. 基础的；基本的' },
  { cn: 'vt. 以…为基础' },
]
const abstractMeanings = [
  { cn: 'adj. 抽象的' },
  { cn: 'adj. 深奥的' },
  { cn: 'n. 抽象概念' },
  { cn: 'n. 摘要；梗概' },
  { cn: 'v. 提取；抽取' },
  { cn: 'v. 抽象化' },
  { cn: 'v. 转移（注意力）' },
]
const tunnelMeanings = [{ cn: 'n. 隧道；地道' }, { cn: 'v. 挖隧道' }, { cn: 'n. 洞穴' }]

const golden = {
  plan: {
    headword: 'plan',
    coreSenses: [
      { index: 1, label: '平面图', gloss: '平铺绘制的图形，后指图纸、示意图', origin: '拉丁 planum=平面', confidence: 'high' },
      { index: 2, label: '计划', gloss: '预先安排的行动方案', origin: '图纸义=方案', confidence: 'high' },
      { index: 3, label: '设计', gloss: '为建造或制作预先画出方案', confidence: 'medium' },
    ],
    meaningMap: [
      { meaningIndex: 1, coreSenseIndex: 2, steps: ['平面图', '按图施工的方案', '预先安排'] },
      { meaningIndex: 2, coreSenseIndex: 1 },
      { meaningIndex: 3, coreSenseIndex: 2 },
      { meaningIndex: 4, coreSenseIndex: 3 },
    ],
  },
  base: {
    headword: 'base',
    coreSenses: [
      { index: 1, label: '基础', gloss: '事物的根本或起点，可作支撑', origin: '希腊 basis=基础', confidence: 'high' },
      { index: 2, label: '底部', gloss: '物体最下面的支撑部分', confidence: 'high' },
      { index: 3, label: '基地', gloss: '活动或驻扎的固定地点', origin: '基础义=地点', confidence: 'medium' },
    ],
    meaningMap: [
      { meaningIndex: 1, coreSenseIndex: 1 },
      { meaningIndex: 2, coreSenseIndex: 2 },
      { meaningIndex: 3, coreSenseIndex: 3 },
      { meaningIndex: 4, coreSenseIndex: 1 },
      { meaningIndex: 5, coreSenseIndex: 1 },
    ],
  },
  abstract: {
    headword: 'abstract',
    coreSenses: [
      { index: 1, label: '抽取', gloss: '从整体中取出某一部分', origin: '拉丁 abs+tract=抽离', confidence: 'high' },
      { index: 2, label: '抽象概念', gloss: '从具体事物中概括出的观念', origin: '抽取义=抽象概念', confidence: 'high' },
      { index: 3, label: '摘要', gloss: '抽取要点形成的短文', origin: '抽取义=摘要', confidence: 'medium' },
    ],
    meaningMap: [
      { meaningIndex: 1, coreSenseIndex: 2 },
      { meaningIndex: 2, coreSenseIndex: 2 },
      { meaningIndex: 3, coreSenseIndex: 2 },
      { meaningIndex: 4, coreSenseIndex: 3, steps: ['抽取', '抽取要点', '摘要'] },
      { meaningIndex: 5, coreSenseIndex: 1 },
      { meaningIndex: 6, coreSenseIndex: 2, steps: ['抽取', '抽取共同点', '抽象化'] },
      { meaningIndex: 7, coreSenseIndex: 1, steps: ['抽取', '抽走', '转移'] },
    ],
  },
  tunnel: {
    headword: 'tunnel',
    coreSenses: [
      { index: 1, label: '隧道', gloss: '在地下或山中挖出的通道', origin: '古法语 tonel=桶', confidence: 'high' },
      { index: 2, label: '挖掘通道', gloss: '开凿地下通道的动作', confidence: 'high' },
    ],
    meaningMap: [
      { meaningIndex: 1, coreSenseIndex: 1 },
      { meaningIndex: 2, coreSenseIndex: 2, steps: ['隧道', '开凿隧道'] },
      { meaningIndex: 3, coreSenseIndex: 1 },
    ],
  },
}

describe('semantics v4 golden cases', () => {
  const cases: Array<[string, (typeof golden)[keyof typeof golden], Array<{ cn: string }>]> = [
    ['plan', golden.plan, planMeanings],
    ['base', golden.base, baseMeanings],
    ['abstract', golden.abstract, abstractMeanings],
    ['tunnel', golden.tunnel, tunnelMeanings],
  ]

  for (const [name, item, meanings] of cases) {
    it(`${name}: 期望输出通过 v4 校验`, () => {
      const r = validateSemanticsV4Items({ json: { items: [item] }, targets: [{ headword: name, meanings }] })
      expect(r.errors).toEqual([])
      expect(r.byKey.size).toBe(1)
      const got = r.byKey.get(name)!
      expect(got).toBeDefined()
      expect(got.coreSenses!).toHaveLength(item.coreSenses!.length)
      expect(got.meaningMap!).toHaveLength(meanings.length)
      // gloss 落库到 CoreSense.note
      for (const sense of got.coreSenses!) {
        expect(sense.label.length).toBeGreaterThanOrEqual(2)
        expect(sense.label.length).toBeLessThanOrEqual(6)
      }
    })
  }

  it('反例：label 写成检查步骤 → 报 E_LABEL_BANNED', () => {
    const bad = structuredClone(golden.plan)
    bad.coreSenses[0]!.label = '看是否指图纸'
    const r = validateSemanticsV4Items({ json: { items: [bad] }, targets: [{ headword: 'plan', meanings: planMeanings }] })
    expect(r.byKey.size).toBe(0)
    expect(r.errors.some((e) => e.includes('E_LABEL_BANNED'))).toBe(true)
  })

  it('反例：origin 只有来源无解释 → 报 E_ORIGIN_NO_EXPLAIN', () => {
    const bad = structuredClone(golden.base)
    bad.coreSenses[0]!.origin = '源自希腊 basis'
    const r = validateSemanticsV4Items({ json: { items: [bad] }, targets: [{ headword: 'base', meanings: baseMeanings }] })
    expect(r.byKey.size).toBe(0)
    expect(r.errors.some((e) => e.includes('E_ORIGIN_NO_EXPLAIN'))).toBe(true)
  })

  it('反例：缺 meaningMap 覆盖 → 不通过', () => {
    const bad = structuredClone(golden.abstract)
    bad.meaningMap = bad.meaningMap.filter((m) => m.meaningIndex !== 7)
    const r = validateSemanticsV4Items({ json: { items: [bad] }, targets: [{ headword: 'abstract', meanings: abstractMeanings }] })
    expect(r.byKey.size).toBe(0)
    expect(r.errors.length).toBeGreaterThan(0)
  })
})
