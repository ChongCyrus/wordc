import { describe, expect, it } from 'vitest'
import { meaningsForMemory } from '../../src/ui/study/lib/study-meanings'

const meanings = [
  { id: 'm1', cn: '甲' },
  { id: 'm2', cn: '乙' },
  { id: 'm3', cn: '丙' },
]

describe('task-197 边界：全部 c 不常考时回退', () => {
  it('部分 rare 过滤；全部 rare 回退全部（不产生 0 个 c）', () => {
    expect(meaningsForMemory(meanings, ['m2'], true).map((m) => m.id)).toEqual(['m1', 'm3'])
    expect(meaningsForMemory(meanings, ['m1', 'm2', 'm3'], true)).toEqual(meanings)
    expect(meaningsForMemory(meanings, ['m1', 'm2', 'm3'], false)).toEqual(meanings)
    expect(meaningsForMemory(meanings, [], true)).toEqual(meanings)
    expect(meaningsForMemory([], ['m1'], true)).toEqual([])
  })
})
