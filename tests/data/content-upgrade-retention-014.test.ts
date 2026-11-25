import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { hashContentValue } from '../../src/data/content-snapshot'
import {
  CONTENT_MIGRATION_STATE_KEY,
  getDb,
  getSettings,
  rebuildContentCacheFromSqlite,
  resetDatabase,
  setSqliteTransport,
  switchContentWriteSource,
} from '../../src/data'

afterEach(() => setSqliteTransport(null))

const ROWS = [
  { key: 'deck:custom', kind: 'deck', json: JSON.stringify({ id: 'custom', name: 'C', source: 'custom', wordCount: 1, version: 1, isDefault: false, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 1, deleted: 0 },
  { key: 'word:custom:w', kind: 'word', json: JSON.stringify({ id: 'custom:w', deckId: 'custom', headword: 'w', headwordLower: 'w', meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 2, deleted: 0 },
  { key: 'word-overlay:custom:w', kind: 'word-overlay', json: JSON.stringify({ rootEtymology: { parts: [{ type: 'root', text: 'keep', meaning: '保持' }], etymology: 'QA_UPGRADE' }, updatedAt: 2 }), updated_at: 2, revision: 3, deleted: 0 },
]
function mockKv() {
  setSqliteTransport({ sqliteCall(json: string) {
    const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r`
    setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: ROWS.length, deleted: 0, byKind: {}, revision: 10 })); else if (req.method === 'contentList') cb?.(id, JSON.stringify({ ok: true, revision: 10, rows: ROWS, hasMore: false })); else cb?.(id, JSON.stringify({ ok: true })) }, 0)
    return JSON.stringify({ requestId: id })
  } })
}
async function hashRows(kind: 'content' | 'learning'): Promise<string> {
  const db = getDb()
  if (kind === 'content') {
    const decks = (await db.decks.toArray()).filter((d) => !d.builtinKey && d.source !== 'builtin')
    const deckIds = new Set(decks.map((d) => d.id))
    const words = (await db.words.toArray()).filter((w) => deckIds.has(w.deckId))
    const norm = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort()
    return hashContentValue({ decks: norm(decks), words: norm(words), rejects: norm(await db.contentRejects.toArray()) })
  }
  const [states, plans, logs, settings] = await Promise.all([db.states.toArray(), db.plans.toArray(), db.reviewLogs.toArray(), db.settings.toArray()])
  const norm = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort()
  return hashContentValue({ states: norm(states), plans: norm(plans), logs: norm(logs), settings: norm(settings) })
}
describe('0.14 final gate: 覆盖安装/重启数据保留（无旧版迁移）', () => {
  it('0.14→0.14 重启/覆盖后 learning facts 与内容都保留', async () => {
    await resetDatabase()
    const db = getDb()
    await db.meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'ready', writeCoverageComplete: true, idbFingerprint: { version: 1 }, revision: 10 }, updatedAt: Date.now() })
    mockKv()
    expect((await switchContentWriteSource()).ok).toBe(true)
    expect((await rebuildContentCacheFromSqlite()).ok).toBe(true)
    // 学习 facts（覆盖安装/重启必须保留）
    await db.states.put({ wordId: 'custom:w', deckId: 'custom', clicks: 3, encounters: 5, lastRating: 'familiar', updatedAt: 7 } as never)
    await db.plans.put({ id: 'plan:custom', date: '2026-11-24', deckId: 'custom', wordIds: ['custom:w'], index: 0, sources: { 'custom:w': 'goal' }, goals: { dailyGoal: 1, dueCount: 0, newBudget: 1, extraCount: 0 }, ratings: [], createdAt: 1, updatedAt: 7, completedAt: null } as never)
    await db.reviewLogs.put({ id: 'log:1', wordId: 'custom:w', deckId: 'custom', rating: 'familiar', at: 7, scheduleMode: 'normal' } as never)
    await db.settings.put({ key: 'qa.retention', value: true, updatedAt: 7 } as never)
    const contentBefore = await hashRows('content')
    const learningBefore = await hashRows('learning')
    const countsBefore = { states: await db.states.count(), plans: await db.plans.count(), logs: await db.reviewLogs.count(), settings: await db.settings.count() }

    // 模拟覆盖安装/重启：仅重置内容 cache（settings/migration/content_kv 保留）
    await db.transaction('rw', [db.decks, db.words, db.packs, db.packItems, db.contentRejects], async () => {
      await db.decks.clear(); await db.words.clear(); await db.packs.clear(); await db.packItems.clear(); await db.contentRejects.clear()
    })
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok).toBe(true)

    expect(await hashRows('learning')).toBe(learningBefore)
    expect(await hashRows('content')).toBe(contentBefore)
    expect({ states: await db.states.count(), plans: await db.plans.count(), logs: await db.reviewLogs.count(), settings: await db.settings.count() }).toEqual(countsBefore)
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')
    expect((await db.meta.get(CONTENT_MIGRATION_STATE_KEY))?.value).toMatchObject({ status: 'ready', writeCoverageComplete: true })
    expect((await db.words.get('custom:w'))?.rootEtymology?.etymology).toBe('QA_UPGRADE')
  }, 120000)
})
