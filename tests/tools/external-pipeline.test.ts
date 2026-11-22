import './../data/test-utils'

import { describe, expect, it } from 'vitest'

// @ts-expect-error 项目未装 @types/node（测试写临时文件）
import { mkdtempSync, writeFileSync } from 'node:fs'
// @ts-expect-error 项目未装 @types/node
import { tmpdir } from 'node:os'
// @ts-expect-error 项目未装 @types/node
import { join } from 'node:path'

import { getDb } from '../data/test-utils'
import { importPack, parsePackFile } from '../../src/data/packs.repo'
import type { Word } from '../../src/core'

// @ts-expect-error tools 为 .mjs 纯脚本，无 TS 类型
import { buildPackFromEntries, parseInputFile } from '../../tools/normalize-external-pack.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wordc-ext-'))
const write = (name: string, lines: unknown[]) => {
  const file = join(dir, name)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

const SEM = [
  { headword: 'charge', meanings: [{ meaningIndex: 1, coreSenseLabel: '收费', confidence: 'high' }, { meaningIndex: 2, coreSenseLabel: '控告', confidence: 'medium' }] },
  { headword: 'abstract', meanings: [{ meaningIndex: 1, coreSenseLabel: '摘要', confidence: 'high' }, { meaningIndex: 2, coreSenseLabel: '抽象概念', confidence: 'high' }] },
]
const CONTENT = [
  { headword: 'charge', kind: 'examples', examples: [{ en: 'He was charged with theft.', cn: '他被指控盗窃。' }] },
  { headword: 'charge', kind: 'phrases', phrases: [{ en: 'in charge of', cn: '负责' }] },
  { headword: 'charge', kind: 'mnemonics', mnemonics: [{ type: 'assoc', text: '装东西→装责任' }] },
]

describe('外部/子代理 JSONL 流水线（task-83）', () => {
  it('语义 per-c label → normalize → parsePackFile 通过', async () => {
    const file = write('sem.jsonl', SEM)
    const pack = buildPackFromEntries([parseInputFile(file)], { kind: 'semantics' }).pack
    expect(pack.kind).toBe('semantics')
    expect(pack.items).toHaveLength(2)
    expect(pack.items[0].coreSenses.map((c: { label: string }) => c.label)).toEqual(['收费', '控告'])
    const parsed = await parsePackFile(JSON.stringify(pack))
    expect(parsed.issues.filter((x) => x.level === 'error')).toEqual([])
    expect(parsed.ok).toBe(true)
  })

  it('内容 JSONL（examples/phrases/mnemonics）→ mixed pack 并通过 schema', async () => {
    const file = write('content.jsonl', CONTENT)
    const pack = buildPackFromEntries([parseInputFile(file)]).pack
    expect(pack.kind).toBe('mixed')
    expect(pack.items).toHaveLength(1)
    const parsed = await parsePackFile(JSON.stringify(pack))
    expect(parsed.ok).toBe(true)
  })

  it('坏行有行号 errors，不中断其它行', () => {
    const file = write('bad.jsonl', [{ headword: 'charge', meanings: [{ meaningIndex: 1, coreSenseLabel: '收费' }] }, { nope: 1 }])
    const res = buildPackFromEntries([parseInputFile(file)])
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.errors[0].where).toContain('bad.jsonl:2')
    expect(res.ok).toBe(true)
  })

  it('输出 pack 可被 App importPack（fake-indexeddb）导入', async () => {
    const file = write('sem2.jsonl', SEM)
    const pack = buildPackFromEntries([parseInputFile(file)], { kind: 'semantics' }).pack
    const db = getDb()
    const deckId = 'ext-validation'
    await db.decks.put({ id: deckId, name: 'ext', source: 'import', createdAt: 1, updatedAt: 1, wordCount: 0 } as never)
    const words: Word[] = []
    for (const it of pack.items as Array<{ headword: string; headwordLower: string; meaningMap: unknown[] }>) {
      const id = `${deckId}:${it.headwordLower}`
      words.push({
        id, deckId, headword: it.headword, headwordLower: it.headwordLower, order: words.length + 1,
        difficulty: 5, tags: [],
        meanings: it.meaningMap.map((_: unknown, i: number) => ({ id: `${id}#M${i + 1}`, cn: '验证' })),
        examples: [], phrases: [], mnemonics: [], createdAt: 1, updatedAt: 1,
      } as unknown as Word)
    }
    await db.words.bulkPut(words)
    const imported = await importPack(JSON.stringify(pack), { deckId })
    expect(imported.ok).toBe(true)
    expect(imported.preview.counts.matched).toBe(2)
  }, 120000)
})
