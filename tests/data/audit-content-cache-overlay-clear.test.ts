import './test-utils'
/**
 * 审计 E 复现 2：applyContentCache 的 word-overlay tombstone 分支只清 rootEtymology，
 * 其余 overlay 字段（derivationMap / senseMnemonics / userNotes …）在 IDB 残留，
 * 下次 saveWordOverlay 会把残留写回 content_kv（删除被撤销）。
 */
import { describe, expect, it } from 'vitest'
import { getDb, resetDatabase } from '../../src/data'
import { applyContentCache } from '../../src/data/content-write-source'

describe('回归：cache overlay tombstone 清全部 overlay 字段', () => {
  it('derivationMap / senseMnemonics 在 tombstone 后仍残留于 IDB', async () => {
    await resetDatabase()
    const db = getDb()
    await db.words.put({
      id: 'w1', deckId: 'd', headword: 'abandon', headwordLower: 'abandon',
      meanings: [{ id: 'm1', cn: '放弃' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1,
      rootEtymology: { parts: [{ type: 'root', text: 'a-' }], source: 'ai', updatedAt: 1 },
      derivationMap: { rootLabel: 'a-', text: '用户引申图', source: 'manual', updatedAt: 1 },
      senseMnemonics: [{ coreSenseIndex: 1, label: '核心', text: '用户本义助记' }],
      userNotes: [{ id: 'n1', text: '我的笔记' }],
      createdAt: 1, updatedAt: 1,
    } as never)

    // content_kv：该 overlay 行已被删除（tombstone）
    await applyContentCache([{ key: 'word-overlay:w1', kind: 'word-overlay', json: 'null', deleted: true, updatedAt: 2 }])

    const after = await db.words.get('w1')
    expect(after?.rootEtymology).toBeUndefined()
    expect(after?.derivationMap).toBeUndefined()
    expect(after?.senseMnemonics?.length).toBeUndefined()
    expect(after?.userNotes?.length).toBeUndefined()
  })
})
