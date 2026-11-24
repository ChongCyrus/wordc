import './test-utils'

import { describe, expect, it } from 'vitest'

// @ts-expect-error 项目未装 @types/node（仅测试读取私仓真实 pack）
import { existsSync, readFileSync } from 'node:fs'

import { ensureBuiltinDecks, getDb, resetDatabase } from '../../src/data'
import {
  applyApproved,
  approveItems,
  importPack,
  listPackItems,
} from '../../src/data'

const REAL_PACKS = [
  {
    path: 'data/packs/dagang/semantics-full-5528.pack.json',
    deckId: 'kaoyan-2027-dagang',
    expectItems: 5528,
  },
  {
    path: 'data/packs/dagang/semantics-bikao-v37.pack.json',
    deckId: 'kaoyan-2027-dagang',
    expectItems: 1832,
  },
]

// 真 pack 集成测试耗时/内存较大（9.6MB pack）：默认跳过，仅在 CI/显式设置 REAL_PACKS_TEST=1 时运行
const RUN_REAL_PACKS =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.REAL_PACKS_TEST === '1'
const hasRealPacks = RUN_REAL_PACKS && REAL_PACKS.every((pack) => existsSync(pack.path))

/**
 * task-90 真 pack 集成测试（私仓才有 data/packs；公开树自动跳过）：
 * 商业词表语义 pack 与大纲同 headword 冲突时，必须按 pack.meta.deckId 解析到商业词表 deck，
 * applyApproved 后全量 applied（不再大量 unknown-meaning）。
 */
describe.skipIf(!hasRealPacks)('真实 pack：大 pack 导入性能（task-95）', () => {
  it('examples-phrases-full（28777 条）导入 <30s，28k 条全部落库', async () => {
    const path = 'data/packs/dagang/examples-phrases-full.pack.json'
    if (!existsSync(path)) return
    await resetDatabase()
    await ensureBuiltinDecks()
    const raw = readFileSync(path, 'utf8') as string
    const start = Date.now()
    const imported = await importPack(raw, { resolveAllDecks: true })
    const elapsed = Date.now() - start
    expect(imported.ok, imported.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(imported.preview.counts.matched).toBe(28777)
    expect(imported.preview.skipped).toHaveLength(0)
    const items = await listPackItems(imported.packId!)
    expect(items.length).toBe(28777)
    console.log(`[perf] examples-phrases-full import: ${elapsed}ms`)
    expect(elapsed).toBeLessThan(30_000)
  }, 180_000)
})

describe.skipIf(!hasRealPacks)('真实 pack：meta.deckId 修复后全量应用', () => {
  it('商业词表 semantics-full-5528：5528 条全部 applied（skipped=0）', async () => {
    await resetDatabase()
    await ensureBuiltinDecks()
    const raw = readFileSync(REAL_PACKS[0]!.path, 'utf8') as string
    const imported = await importPack(raw, { resolveAllDecks: true })
    expect(imported.ok, imported.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(imported.preview.counts.matched).toBe(5528)
    expect(imported.preview.skipped).toHaveLength(0)

    const items = await listPackItems(imported.packId!)
    expect(items.length).toBe(5528)
    await approveItems(imported.packId!, items.filter((item) => item.status === 'pending').map((item) => item.id))
    const applied = await applyApproved(imported.packId!)
    expect(applied.applied).toBe(5528)
    expect(applied.skipped).toBe(0)
    const itemRows = await getDb().packItems.where('packId').equals(imported.packId!).toArray()
    expect(itemRows.filter((item) => item.status === 'applied').length).toBe(5528)
    expect(itemRows.filter((item) => item.status === 'skipped').length).toBe(0)
  }, 180_000)

  it('商业词表 semantics-bikao-v37：1832 条全部 applied', async () => {
    await resetDatabase()
    await ensureBuiltinDecks()
    const raw = readFileSync(REAL_PACKS[1]!.path, 'utf8') as string
    const imported = await importPack(raw, { resolveAllDecks: true })
    expect(imported.ok).toBe(true)
    expect(imported.preview.counts.matched).toBe(REAL_PACKS[1]!.expectItems)
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.filter((item) => item.status === 'pending').map((item) => item.id))
    const applied = await applyApproved(imported.packId!)
    expect(applied.applied).toBe(REAL_PACKS[1]!.expectItems)
    expect(applied.skipped).toBe(0)
    const row = (await getDb().packItems.where('packId').equals(imported.packId!).toArray())[0]!
    expect(row.deckId).toBe(REAL_PACKS[1]!.deckId)
  }, 180_000)
})
