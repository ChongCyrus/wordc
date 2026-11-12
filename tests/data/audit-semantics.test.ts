/**
 * task-97 · 本义审计工具 + normalize --strict-semantics 单测（纯离线，无网络）
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error tools/*.mjs 无 TS 类型
import { auditPack, auditSemanticsItem } from '../../tools/audit-semantics-pack.mjs'
// @ts-expect-error 同上
import { normalizeEntries } from '../../tools/normalize-external-pack.mjs'

const validItem = {
  headword: 'plan',
  coreSenses: [
    { index: 1, label: '平面图', note: '平铺绘制的图形，后指图纸', origin: '拉丁 planum=平面', confidence: 'high' },
    { index: 2, label: '计划', note: '预先安排的行动方案', origin: '图纸义=方案', confidence: 'high' },
  ],
  meaningMap: [
    { meaningIndex: 1, coreSenseIndex: 2, steps: ['平面图', '预先安排'] },
    { meaningIndex: 2, coreSenseIndex: 1 },
  ],
}

function samplePack(items: unknown[]) {
  return {
    format: 'momo-pack',
    formatVersion: 1,
    kind: 'semantics',
    checksum: 'x'.repeat(64),
    items,
    meta: { deckId: 'test-deck', promptVersion: 'v3.7-semantics' },
  }
}

describe('task-97 · audit-semantics-pack', () => {
  it('合法 v4 item 无违规', () => {
    expect(auditSemanticsItem(validItem)).toEqual([])
  })

  it('合法含义词（检查/看法/可能性/朝外看）不被黑名单误杀', () => {
    const codes = (label: string) =>
      auditSemanticsItem({
        headword: 'x',
        coreSenses: [{ index: 1, label, note: '解释' }],
        meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
      })
    for (const label of ['检查', '看法', '可能性', '朝外看']) expect(codes(label)).toEqual([])
    expect(codes('检查是否指图').map((violation: { code: string }) => violation.code)).toContain('E_LABEL_BANNED')
  })

  it('label 检查步骤/词源/箭头/超长 → 对应错误码', () => {
    const codes = (label: string) =>
      auditSemanticsItem({
        headword: 'x',
        coreSenses: [{ index: 1, label, note: '解释' }],
        meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
      }).map((violation: { code: string }) => violation.code)
    expect(codes('看是否指图纸')).toContain('E_LABEL_BANNED')
    expect(codes('源自希腊')).toContain('E_LABEL_BANNED')
    expect(codes('本义→引申')).toContain('E_LABEL_FORMAT') // 含箭头 → 格式错误（先于黑名单判定）
    expect(codes('这是一个非常长的本义标签')).toContain('E_LABEL_FORMAT')
  })

  it('origin 无解释 → E_ORIGIN_NO_EXPLAIN；含解释则通过', () => {
    const base = { headword: 'x', coreSenses: [{ index: 1, label: '基础', note: '根本' }], meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }] }
    const bad = auditSemanticsItem({ ...base, coreSenses: [{ ...base.coreSenses[0], origin: '源自希腊 basis' }] })
    expect(bad.map((violation: { code: string }) => violation.code)).toContain('E_ORIGIN_NO_EXPLAIN')
    const good = auditSemanticsItem({ ...base, coreSenses: [{ ...base.coreSenses[0], origin: '希腊 basis=基础' }] })
    expect(good).toEqual([])
  })

  it('steps 检查词/步数不足 → E_STEPS_*', () => {
    const item = {
      headword: 'x',
      coreSenses: [{ index: 1, label: '抽取', note: '取出' }],
      meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1, steps: ['看是否抽离'] }],
    }
    const codes = auditSemanticsItem(item).map((violation: { code: string }) => violation.code)
    expect(codes).toContain('E_STEPS_COUNT')
    expect(codes).toContain('E_STEPS_BANNED')
  })

  it('同词重复/近义 label、孤儿本义 → 可识别', () => {
    const item = {
      headword: 'x',
      coreSenses: [
        { index: 1, label: '计划', note: '方案' },
        { index: 2, label: '计划', note: '重复' },
        { index: 3, label: '设计', note: '画图' },
        { index: 4, label: '基础', note: '根本' },
      ],
      meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
    }
    const codes = auditSemanticsItem(item).map((violation: { code: string }) => violation.code)
    expect(codes).toContain('E_LABEL_DUP')
    expect(codes).toContain('E_SENSE_ORPHAN')
  })

  it('旧 v3 per-c payload.coreSenseLabel：链上括号内容也会被审计', () => {
    const item = {
      headword: 'domain',
      coreSenses: [{ index: 1, label: '领域', note: '范围' }],
      meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1 }],
      payload: { meanings: [{ meaningIndex: 1, coreSenseLabel: '领域义的网络化' }, { meaningIndex: 2, coreSenseLabel: '看是否指辖域' }] },
    }
    const violationList = auditSemanticsItem(item)
    const legacy = violationList.filter((violation: { field: string }) => violation.field === 'legacyCoreLabel')
    expect(legacy.length).toBeGreaterThanOrEqual(1)
    expect(legacy.map((violation: { code: string }) => violation.code)).toContain('E_LEGACY_LABEL_BANNED')
    expect(legacy.some((violation: { value: string }) => violation.value === '看是否指辖域')).toBe(true)
  })

  it('auditPack 统计：违规词数 / 条目数 / 按字段分类 / byCode', () => {
    const pack = samplePack([
      validItem,
      { headword: 'base', headwordLower: 'base', coreSenses: [{ index: 1, label: '源自希腊', note: 'x' }], meaningMap: [] },
    ])
    const result = auditPack('sample.pack.json', pack)
    expect(result.words).toBe(2)
    expect(result.violatingWords).toBe(1)
    expect(result.violationRate).toBe(50)
    expect(result.byCategory.label).toBe(1)
    expect(result.byField.coreLabel).toBe(1)
    expect(result.violationEntries).toBeGreaterThanOrEqual(1)
    expect(result.byCode.E_LABEL_BANNED).toBe(1)
  })
})

describe('task-97 · normalize --strict-semantics', () => {
  it('strict：丢弃非法 label 的 coreSense 并重映射 meaningMap；清空无解释 origin', () => {
    const inputs = [
      {
        file: 'test.jsonl',
        entries: [
          {
            __line: 1,
            headword: 'plan',
            coreSenses: [
              { index: 1, label: '看是否指计划', note: '检查步骤', origin: '源自希腊 basis' },
              { index: 2, label: '计划', note: '预先安排', origin: '源自希腊 basis' },
            ],
            meaningMap: [
              { meaningIndex: 1, coreSenseIndex: 1 },
              { meaningIndex: 2, coreSenseIndex: 2 },
            ],
          },
        ],
      },
    ]
    const strict = normalizeEntries(inputs, { strictSemantics: true })
    expect(strict.errors).toEqual([])
    expect(strict.warnings.some((warning: string) => warning.includes('drop-label'))).toBe(true)
    expect(strict.items).toHaveLength(1)
    const item = strict.items[0]
    expect(item.coreSenses.map((sense: { label: string }) => sense.label)).toEqual(['计划'])
    expect(item.meaningMap).toEqual([{ meaningIndex: 2, coreSenseIndex: 1 }])
    expect(item.coreSenses[0].origin).toBeUndefined() // 「源自希腊 basis」被清空
    // 非 strict：保留原样（仅 warnings）
    const loose = normalizeEntries(inputs)
    expect(loose.items[0].coreSenses).toHaveLength(2)
  })
})
