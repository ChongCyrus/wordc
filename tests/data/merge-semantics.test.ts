/** task-99 · merge-semantics-packs（v4 重生成结果替换旧 pack 对应词） */
import { describe, expect, it } from 'vitest'
// @ts-expect-error tools/*.mjs 无 TS 类型
import { mergeSemanticsPacks, packChecksum } from '../../tools/merge-semantics-packs.mjs'

function pack(items: unknown[], promptVersion = 'v3.7-semantics') {
  return {
    format: 'momo-pack',
    formatVersion: 1,
    kind: 'semantics',
    checksum: '',
    items,
    meta: { deckId: 'd1', promptVersion, name: 'old' },
  }
}

describe('task-99 · mergeSemanticsPacks', () => {
  it('按 headwordLower 替换、保留其它词、追加新词、重算 checksum + v4 promptVersion', () => {
    const base = pack([
      { headword: 'a', headwordLower: 'a', coreSenses: [{ index: 1, label: '旧A', note: 'x' }], meaningMap: [] },
      { headword: 'b', headwordLower: 'b', coreSenses: [{ index: 1, label: 'B', note: 'x' }], meaningMap: [] },
    ])
    const regen = pack(
      [
        { headword: 'a', headwordLower: 'a', coreSenses: [{ index: 1, label: '新A', note: 'y' }], meaningMap: [] },
        { headword: 'c', headwordLower: 'c', coreSenses: [{ index: 1, label: 'C', note: 'z' }], meaningMap: [] },
      ],
      'v4.0-semantics-grouped',
    )
    const result = mergeSemanticsPacks(base, regen)
    expect(result.replacedCount).toBe(1)
    expect(result.appendedCount).toBe(1)
    expect(result.pack.items.map((item: { headwordLower: string }) => item.headwordLower)).toEqual(['a', 'b', 'c'])
    expect(result.pack.items[0].coreSenses[0].label).toBe('新A')
    expect(result.pack.items[1].coreSenses[0].label).toBe('B')
    expect(result.pack.meta.promptVersion).toBe('v4.0-semantics-grouped')
    expect(result.pack.checksum).toBe(packChecksum(result.pack))
    expect(result.pack.checksum).toHaveLength(64)
  })
})
