import './test-utils'
/**
 * 回归：确保 ensureBuiltinDecks 的 seedOne → diffReplaceDeckWords 用打包正文整行
 * bulkPut，会丢掉 IDB cache 里该词的 overlay 字段（rootEtymology/derivationMap/笔记…）。
 * sqlite 单一事实源下 overlay 只存在于 content_kv；随后任意一次 overlay 保存
 * （upsertUserNote 等 → saveWordOverlay(word)）都会把「只剩新字段」的 overlay
 * 整行写回 content_kv，覆盖掉 kv 里原有的 rootEtymology / 引申图 / 本义助记。
 */
import { describe, expect, it } from 'vitest'
import { getDb, resetDatabase } from '../../src/data'
import { diffReplaceDeckWords } from '../../src/data/word-mutation'
import { wordOverlayOf } from '../../src/data/content-snapshot'

describe('审计 E：内置重种丢 IDB overlay 后，下一次 overlay 保存会截断 content_kv', () => {
  it('重种 → 用户加笔记 → 写回 kv 的 overlay 丢失 rootEtymology/derivationMap', async () => {
    await resetDatabase()
    const db = getDb()
    await db.decks.put({ id: 'kaoyan-2027-dagang', name: 'dagang', source: 'builtin', builtinKey: 'dagang', wordCount: 1, version: 1, isDefault: true, createdAt: 1, updatedAt: 1 } as never)

    const kcRichOverlay = {
      id: 'kaoyan-2027-dagang:abandon', deckId: 'kaoyan-2027-dagang', headword: 'abandon', headwordLower: 'abandon',
      meanings: [{ id: 'm1', cn: '放弃' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1,
      rootEtymology: { parts: [{ type: 'root', text: 'a-' }], source: 'ai', updatedAt: 1 },
      derivationMap: { rootLabel: 'a-', text: '引申图内容', source: 'manual', updatedAt: 1 },
      senseMnemonics: [{ coreSenseIndex: 1, label: '核心', text: '本义助记' }],
      userNotes: [{ id: 'n0', text: '旧笔记' }],
      createdAt: 1, updatedAt: 1,
    }
    await db.words.put(kcRichOverlay as never)

    // 1) 内置数据版本升级：seedOne → diffReplaceDeckWords 用打包正文整行覆盖
    const builtinBody = { ...kcRichOverlay } as Record<string, unknown>
    for (const field of ['rootEtymology', 'derivationMap', 'senseMnemonics', 'userNotes']) delete builtinBody[field]
    await diffReplaceDeckWords('kaoyan-2027-dagang', [builtinBody as never], 'builtin-seed')

    // 2) 重种后 IDB cache 里的词确实丢了 overlay（缓存问题，可重建）
    const afterReseed = await db.words.get(kcRichOverlay.id)
    expect(afterReseed?.rootEtymology).toBeTruthy()
    expect(afterReseed?.derivationMap).toBeTruthy()
    expect(afterReseed?.senseMnemonics?.length).toBe(1)

    // 3) 用户此时加一条笔记：user-content 的路径是 read word → saveWordOverlay(word)
    const wordForSave = { ...(afterReseed as unknown as Record<string, unknown>), userNotes: [{ id: 'n1', text: '新笔记' }] }
    const overlayWritten = wordOverlayOf(wordForSave) as { rootEtymology?: unknown; derivationMap?: unknown; senseMnemonics?: unknown[]; userNotes?: unknown[] }

    // 4) 写回 content_kv 的 overlay 只剩 userNotes：rootEtymology / derivationMap / 本义助记被截断
    expect(overlayWritten.rootEtymology).toBeTruthy()
    expect(overlayWritten.derivationMap).toBeTruthy()
    expect(overlayWritten.senseMnemonics).toBeTruthy()
    expect(overlayWritten.userNotes).toBeTruthy()
  })
})
