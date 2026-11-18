import { describe, expect, it } from 'vitest'
import { countCoreSenseExportStats } from '../../src/ui/me/core-io-stats'

describe('task-229 导出统计唯一 wordId', () => {
  it('仅候选本义、无 overview 时候选词数仍为 1', () => {
    const stats = countCoreSenseExportStats({
      words: [],
      senses: [
        { wordId: 'deck:denounce', mnemonic: undefined },
      ],
    })
    expect(stats.words).toBe(1)
    expect(stats.senses).toBe(1)
    expect(stats.withMnemonic).toBe(0)
    expect(stats.pending).toBe(1)
  })

  it('words ∪ senses 去重；已有/待生成统计', () => {
    const stats = countCoreSenseExportStats({
      words: [{ wordId: 'w1' }, { wordId: 'w2' }],
      senses: [
        { wordId: 'w1', mnemonic: { text: 'a' } },
        { wordId: 'w1', mnemonic: { text: ' ' } },
        { wordId: 'w2', mnemonic: { text: 'b' } },
        { wordId: 'w3' },
      ],
    })
    expect(stats.words).toBe(3)
    expect(stats.senses).toBe(4)
    expect(stats.withMnemonic).toBe(2)
    expect(stats.pending).toBe(2)
  })
})
