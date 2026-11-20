/**
 * 文档示例校验（task-64）：docs/DATA-FORMAT.md 里的 JSON 示例必须能被 schema.ts 实际解析，
 * 迁移包示例的 checksum 必须按 checksum.ts 的算法可复现，防止文档与代码漂移。
 */
// @ts-expect-error 项目未装 @types/node；本测试只在 vitest node 环境使用 Node 内置模块（同其他测试做法）
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDeckFile, parseMigrationFile } from '../../src/data/schema'
import { computeChecksum, migrationChecksumPayload } from '../../src/data/checksum'

const DOC = readFileSync(new URL('../../docs/DATA-FORMAT.md', import.meta.url), 'utf8')

function jsonExamples(): unknown[] {
  const out: unknown[] = []
  for (const m of DOC.matchAll(/```json\n([\s\S]*?)```/g)) {
    out.push(JSON.parse(m[1]) as unknown)
  }
  return out
}

describe('docs/DATA-FORMAT.md 示例', () => {
  it('包含 deck 与 migration 两个示例', () => {
    const formats = jsonExamples().map((j) => (j as { format?: string }).format)
    expect(formats).toContain('momo-deck')
    expect(formats).toContain('momo-migration')
  })

  it('momo-deck 示例能被 parseDeckFile 解析（无 error）', () => {
    const deck = jsonExamples().find((j) => (j as { format?: string }).format === 'momo-deck') as Record<string, unknown>
    const parsed = parseDeckFile(deck)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.words).toHaveLength(2)
    expect(parsed.value.deck.id).toBe('example-deck')
    expect(parsed.issues.filter((i) => i.level === 'error')).toHaveLength(0)
  })

  it('momo-migration 示例 schema 解析通过、counts 自洽', () => {
    const migration = jsonExamples().find(
      (j) => (j as { format?: string }).format === 'momo-migration',
    ) as Record<string, unknown>
    const parsed = parseMigrationFile(migration)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const data = migration.data as Record<string, unknown[]>
    const counts = migration.counts as Record<string, number>
    expect(counts.decks).toBe((data.decks as unknown[]).length)
    expect(counts.words).toBe((data.words as unknown[]).length)
    expect(counts.states).toBe((data.states as unknown[]).length)
    expect(counts.reviewLogs).toBe((data.reviewLogs as unknown[]).length)
  })

  it('migration 示例 checksum 可按 canonical 载荷复现（sha256）', async () => {
    const migration = jsonExamples().find(
      (j) => (j as { format?: string }).format === 'momo-migration',
    ) as Record<string, unknown>
    const canonical = migrationChecksumPayload({
      format: migration.format as string,
      formatVersion: migration.formatVersion as number,
      dataVersion: migration.dataVersion as number,
      data: migration.data,
    })
    const result = await computeChecksum(canonical)
    expect(result.algo).toBe('sha256')
    expect(migration.checksum).toBe(result.hex)
    expect((migration.meta as { checksumAlgo?: string }).checksumAlgo).toBe('sha256')
  })
})
