import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node（仅测试工具脚本）
import { execFileSync } from 'node:child_process'
// @ts-expect-error 同上
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
// @ts-expect-error 同上
import { join } from 'node:path'
// @ts-expect-error 同上
import { tmpdir } from 'node:os'
// @ts-expect-error 工具为 mjs，无类型声明
import { auditSemanticsItem } from '../../tools/audit-semantics-pack.mjs'

describe('task-122：steps 元推理清洗规则', () => {
  it('清洗「4条释义→归为→与其余1义区分」并用 label+note 合成可读两步链', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clean-steps-'))
    const input = join(dir, 'in.pack.json')
    const output = join(dir, 'out.pack.json')
    const pack = {
      format: 'momo-pack', formatVersion: 1, kind: 'semantics', createdAt: Date.now(),
      generator: 'test', checksum: 'x',
      meta: { source: 'ai', promptVersion: 'v4.0-semantics-grouped', deckId: 'kaoyan-2027-dagang' },
      items: [{
        headword: 'ethical', headwordLower: 'ethical',
        coreSenses: [
          { index: 1, label: '处方药', note: '指凭处方出售的药品', confidence: 'medium' },
          { index: 2, label: '伦理的', note: '指合乎伦理道德的', confidence: 'high' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1, steps: ['4条释义', '归为处方药', '与其余1义区分'] },
          { meaningIndex: 2, coreSenseIndex: 2, steps: ['4条释义', '归为伦理的', '与其余1义区分'] },
        ],
      }],
    }
    writeFileSync(input, JSON.stringify(pack))
    const node = (globalThis as { process?: { execPath: string } }).process!
    execFileSync(node.execPath, ['tools/clean-semantics-steps.mjs', '--in', input, '--out', output, '--write'], { cwd: (globalThis as { process?: { cwd(): string } }).process!.cwd() })
    const cleaned = JSON.parse(readFileSync(output, 'utf8')) as { items: Array<{ meaningMap: Array<{ steps?: string[] }> }> }
    expect(cleaned.items[0]!.meaningMap[0]!.steps).toEqual(['处方药', '指凭处方出售的药品'])
    expect(cleaned.items[0]!.meaningMap[1]!.steps).toEqual(['伦理的', '指合乎伦理道德的'])
    for (const mapping of cleaned.items[0]!.meaningMap) {
      expect(JSON.stringify(mapping.steps)).not.toMatch(/通读|释义|归为|区分|其余/)
    }
    const audit = auditSemanticsItem(cleaned.items[0])
    expect(audit.filter((v: { field: string }) => v.field === 'steps')).toHaveLength(0)
  })
})
