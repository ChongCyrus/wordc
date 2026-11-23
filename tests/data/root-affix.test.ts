import { describe, expect, it } from 'vitest'
import { buildRootAffixMappings, pickRepresentativeWords } from '../../src/data/root-affix'

const deck = [
  { id: 'd:panorama', headword: 'panorama', difficulty: 6, meanings: [{ cn: '全景' }] },
  { id: 'd:pandemic', headword: 'pandemic', difficulty: 5, meanings: [{ cn: '流行病' }] },
  { id: 'd:pan', headword: 'pan', difficulty: 2, meanings: [{ cn: '平底锅' }] },
  { id: 'd:panacea', headword: 'panacea', difficulty: 8, meanings: [{ cn: '万灵药' }] },
  { id: 'd:company', headword: 'company', difficulty: 3, meanings: [{ cn: '公司' }] },
]

const panorama = {
  headword: 'panorama',
  rootEtymology: {
    parts: [
      { type: 'prefix', text: 'pan-', meaning: '全部，所有' },
      { type: 'root', text: '-orama', meaning: '景象，视野' },
    ],
    composition: '组合：pan-（全部）+ -orama（景象）→全部景象 → 全景',
  },
}

describe('buildRootAffixMappings', () => {
  it('词根缀 -> 含义，最后一张为完整词 -> composition', () => {
    const result = buildRootAffixMappings(panorama, { deckWords: deck })
    expect(result.ok).toBe(true)
    expect(result.items).toHaveLength(3)
    expect(result.items[0]).toMatchObject({ kind: 'part', type: 'prefix', key: 'pan-', value: '全部，所有' })
    expect(result.items[1]).toMatchObject({ kind: 'part', type: 'root', key: '-orama' })
    expect(result.items[2]).toMatchObject({
      kind: 'word',
      key: 'panorama',
      value: '组合：pan-（全部）+ -orama（景象）→全部景象 → 全景',
    })
  })

  it('代表词按前缀匹配、排除当前词、词短优先、去重', () => {
    const examples = buildRootAffixMappings(panorama, { deckWords: deck }).items[0]!
    expect(examples).toMatchObject({ kind: 'part' })
    if (examples.kind !== 'part') throw new Error('expected part')
    expect(examples.examples!.map((item) => item.headword)).toEqual(['panacea', 'pandemic'])
    expect(examples.examples!.every((item) => item.headword !== 'panorama')).toBe(true)
  })

  it('缺 composition 时用 parts 拼接兜底', () => {
    const result = buildRootAffixMappings({
      headword: 'embed',
      rootEtymology: {
        parts: [
          { type: 'prefix', text: 'em-', meaning: '使进入' },
          { type: 'root', text: 'bed', meaning: '床、层' },
        ],
      },
    })
    expect(result.ok).toBe(true)
    const last = result.items[result.items.length - 1]
    expect(last!.kind).toBe('word')
    expect(last!.value).toContain('组合：em-（使进入） + bed（床、层）')
  })

  it('无词根缀源 / 无有效 parts 返回失败', () => {
    expect(buildRootAffixMappings({ headword: 'gap' }).ok).toBe(false)
    expect(
      buildRootAffixMappings({ headword: 'gap', rootEtymology: { parts: [] } }),
    ).toMatchObject({ ok: false, reason: 'no-parts' })
  })

  it('filter / limit 生效且不会匹配当前词', () => {
    const examples = pickRepresentativeWords('suffix', '-ing', 'sing', [{ id: 'd:sing', headword: 'sing' }])
    expect(examples).toEqual([])
  })
})
