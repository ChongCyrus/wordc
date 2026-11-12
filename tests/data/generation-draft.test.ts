/** task-106 · AI 生成草稿：create/append/cursor/幂等/list/clear */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDatabase } from '../../src/data'
import {
  appendGenerationDraftItems,
  clearGenerationDraft,
  createGenerationDraft,
  getGenerationDraft,
  listGenerationDraftItems,
  listGenerationDrafts,
  updateGenerationDraftCursor,
} from '../../src/data'
import type { PackItemV1 } from '../../src/data'

function item(headword: string, meaningIndex?: number): PackItemV1 {
  return {
    headword,
    ...(meaningIndex != null ? { meaningIndex } : {}),
    examples: [{ en: `${headword} example`, cn: '例句' }],
  }
}

describe('task-106 · generation draft', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('create → append（每片持久化）→ cursor；幂等 append 不重复', async () => {
    await createGenerationDraft({ scope: { kind: 'deck', deckId: 'd1' }, kind: ['examples'], name: '草稿A' })
    const [draft] = await listGenerationDrafts()
    expect(draft).toBeTruthy()
    expect(draft!.meta.cursor).toBe(0)
    expect(draft!.done).toBe(0)

    const first = await appendGenerationDraftItems(draft!.id, [
      { headwordLower: 'alpha', meaningIndex: 1, payload: item('alpha', 1) },
      { headwordLower: 'alpha', meaningIndex: 2, payload: item('alpha', 2) },
    ])
    expect(first.added).toBe(2)
    expect(first.done).toBe(2)

    // 幂等：同 headwordLower+meaningIndex 不再追加
    const again = await appendGenerationDraftItems(draft!.id, [
      { headwordLower: 'alpha', meaningIndex: 1, payload: item('alpha', 1) },
      { headwordLower: 'beta', meaningIndex: 1, payload: item('beta', 1) },
    ])
    expect(again.added).toBe(1)
    expect(again.done).toBe(3)

    await updateGenerationDraftCursor(draft!.id, { cursor: 3, targetTotal: 10 })
    const resumed = await getGenerationDraft(draft!.id)
    expect(resumed!.meta.cursor).toBe(3)
    expect(resumed!.meta.targetTotal).toBe(10)
    expect(resumed!.done).toBe(3)
    expect(resumed!.status).toBe('reviewing')
    expect(resumed!.name).toBe('草稿A')
    // 草稿 items 全 pending，不计入已应用内容
    const rows = await getDb().packItems.where('packId').equals(draft!.id).toArray()
    expect(rows.every((row) => row.status === 'pending')).toBe(true)
  })

  it('list 只返回未完成草稿；clear 删除 pack + items（快路径）', async () => {
    const first = await createGenerationDraft({ scope: null, kind: ['phrases'] })
    await appendGenerationDraftItems(first.id, [{ headwordLower: 'gamma', payload: item('gamma') }])
    const second = await createGenerationDraft({ scope: null, kind: ['examples'] })
    expect((await listGenerationDrafts()).length).toBe(2)

    await clearGenerationDraft(first.id)
    expect(await getGenerationDraft(first.id)).toBeNull()
    expect(await getDb().packs.get(first.id)).toBeUndefined()
    expect(await getDb().packItems.where('packId').equals(first.id).count()).toBe(0)
    expect((await listGenerationDrafts()).map((draft) => draft.id)).toEqual([second.id])

    // 非草稿 pack 不能 clear（防误删正式内容包）
    const db = getDb()
    await db.packs.put({
      id: 'pk_normal', name: '正式包', kind: 'semantics', formatVersion: 1, checksum: 'x'.repeat(64),
      source: 'import', status: 'reviewing', counts: { items: 0, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 0 },
      createdAt: 1, updatedAt: 1,
    })
    await expect(clearGenerationDraft('pk_normal')).rejects.toThrow(/不是生成草稿/)
  })

  it('完成（applied/partial）后不在未完成草稿列表；cursor 更新异常草稿报错', async () => {
    const draft = await createGenerationDraft({ scope: null, kind: ['examples'] })
    await appendGenerationDraftItems(draft.id, [{ headwordLower: 'delta', payload: item('delta') }])
    await getDb().packs.update(draft.id, { status: 'applied' })
    expect((await listGenerationDrafts()).some((entry) => entry.id === draft.id)).toBe(false)
    await expect(updateGenerationDraftCursor('missing-draft', { cursor: 1 })).rejects.toThrow(/不存在/)
  })

  it('task-130：listGenerationDraftItems 返回已生成条目并按 payload 推断 kind', async () => {
    const draft = await createGenerationDraft({ scope: null, kind: ['examples', 'mnemonics'] })
    await appendGenerationDraftItems(draft.id, [
      { headwordLower: 'alpha', meaningIndex: 1, payload: item('alpha', 1) },
      {
        headwordLower: 'alpha', meaningIndex: 2,
        payload: { headword: 'alpha', meaningIndex: 2, mnemonics: [{ type: '联想', text: 'alpha 阿尔法联想' }] },
      },
    ])
    const items = await listGenerationDraftItems(draft.id)
    expect(items.map((entry) => entry.kind)).toEqual(['examples', 'mnemonics'])
    expect(items.map((entry) => entry.meaningIndex)).toEqual([1, 2])
    await expect(listGenerationDraftItems('missing')).rejects.toThrow(/不存在/)
  })

})
