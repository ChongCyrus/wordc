/**
 * 文档示例防漂移：docs/DATA-FORMAT.md §8.6 的 momo-pack 示例可被 checksum 复现，
 * 且不含任何敏感 key。
 */
import { describe, expect, it } from 'vitest'
import { sha256Hex, stableStringify } from '../../../src/data/checksum'

const EXAMPLE = {
  format: 'momo-pack',
  formatVersion: 1,
  kind: 'examples',
  createdAt: 1762790400000,
  generator: 'wordc-ai@0.4.0',
  items: [
    {
      headword: 'embrace',
      headwordLower: 'embrace',
      meaningIndex: 1,
      examples: [{ en: 'She gave him a warm embrace.', cn: '她给了他一个温暖的拥抱。' }],
    },
    {
      headword: 'dog',
      headwordLower: 'dog',
      examples: [{ en: 'The dog barked at the stranger.', cn: '那只狗对着陌生人叫。' }],
    },
  ],
  checksum: '510eb82c490b65bd6df9133ca0a0e9a67f83c2b9c972765f1d627c46093b3459',
  meta: {
    name: '示例内容包',
    source: 'ai',
    provider: 'deepseek',
    model: 'deepseek-chat',
    promptVersion: 'v1',
    createdBy: 'WordC',
    licenseNote: 'AI 生成内容，仅供个人学习使用',
  },
} as const

describe('docs/DATA-FORMAT · momo-pack 示例', () => {
  it('checksum = sha256(stableStringify({format,formatVersion,kind,items}))', async () => {
    const canonical = stableStringify({
      format: EXAMPLE.format,
      formatVersion: EXAMPLE.formatVersion,
      kind: EXAMPLE.kind,
      items: EXAMPLE.items,
    })
    const hex = await sha256Hex(canonical)
    expect(hex).toBe(EXAMPLE.checksum)
  })

  it('定位字段一致（headwordLower + 可选 meaningIndex）且不含 key/token', () => {
    const json = JSON.stringify(EXAMPLE)
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/)
    expect(json).not.toMatch(/api[_-]?key/i)
    for (const item of EXAMPLE.items) {
      expect(item.headwordLower).toBe(item.headword.toLowerCase())
      expect('meaningIndex' in item ? item.meaningIndex : 1).toBeGreaterThanOrEqual(1)
    }
    expect(EXAMPLE.format).toBe('momo-pack')
    expect(EXAMPLE.formatVersion).toBe(1)
  })
})
