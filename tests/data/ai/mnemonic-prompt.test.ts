import { describe, expect, it } from 'vitest'
import { buildSystemPromptMnemonic, buildUserPromptMnemonic, PROMPT_VERSION_MNEMONIC } from '../../../src/data/ai/prompts'
import type { GenerateTarget } from '../../../src/data/ai/types'

const target: GenerateTarget = {
  wordId: 'w1',
  headword: 'fragment',
  headwordLower: 'fragment',
  deckId: 'd1',
  meaningIndex: 2,
  meanings: [
    { id: 'w1#M1', cn: '碎片', pos: 'n.' },
    { id: 'w1#M2', cn: '使碎裂', pos: 'v.' },
  ],
  existing: { examples: 0, phrases: 0, mnemonics: 0 },
}

describe('task-128：助记 prompt w→c 映射', () => {
  it('promptVersion 独立且 system 约束拼写/构词 + 指定含义、禁止纯词源', () => {
    expect(PROMPT_VERSION_MNEMONIC).toBe('v3.0-mnemonic-c')
    const system = buildSystemPromptMnemonic()
    expect(system).toContain('记住「这个单词 w → 这个具体含义 c」的映射')
    expect(system).toContain('不是只解释词根')
    expect(system).toContain('只写词源/词根解释而没有')
    expect(system).toContain('≤60 字')
  })
  it('user prompt 带 meaningIndex/pos/cn，按 c 逐条', () => {
    const user = buildUserPromptMnemonic([target])
    expect(user).toContain('meaningIndex')
    expect(user).toContain('使碎裂')
    expect(user).toContain('v.')
    expect(user).toContain('fragment')
  })
})
