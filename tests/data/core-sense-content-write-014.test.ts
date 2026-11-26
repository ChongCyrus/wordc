import './test-utils'
import { primeLegacySqliteContentSource, resetContentSourceToIdb } from './test-utils'
/**
 * 0.14：core-sense 内容写入口接入统一内容写源（examples / overview / phrases）。
 *
 * 约定：
 * - sqlite 模式：先写 content_kv（`word-overlay:<wordId>`，内置不可变正文不进 SQLite）；
 *   成功后才由 saveWordOverlay 写 IDB cache；失败抛 ContentWriteError（CONTENT_SQLITE_WRITE_FAILED），**IDB 不回写**。
 * - idb 模式：行为与改造前一致（只写 IDB，不调用 contentWrite）。
 *
 * 三个文件各自的 save / clear 写路径都要覆盖：成功、失败、idb。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearCoreSenseExamples,
  clearCoreSenseOverview,
  clearCoreSensePhrases,
  createDeck,
  getCoreSenseOverview,
  getDb,
  getSettings,
  resetDatabase,
  saveCoreSenseExamples,
  saveCoreSenseOverview,
  saveCoreSensePhrases,
  setSqliteTransport,
} from '../../src/data'

interface MockCall {
  method: string
  payload: Record<string, unknown>
}

interface MockEntry {
  key: string
  kind: string
  json: string
  updated_at?: number
}

/** mock 原生 content* 协议；记录调用/写入行，可切换失败 */
function installSqliteMock(opts: { fail?: boolean } = {}) {
  const calls: MockCall[] = []
  let revision = 0
  let seq = 0
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++seq}`
      calls.push({ method: req.method, payload: req.payload ?? {} })
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'contentWrite') {
          if (opts.fail) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock core-sense fail' }))
            return
          }
          revision += 1
          cb?.(id, JSON.stringify({ ok: true, revision }))
          return
        }
        if (req.method === 'contentCounts') {
          cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  } as never)

  const contentWrites = () => calls.filter((call) => call.method === 'contentWrite')
  const entries = (): MockEntry[] =>
    contentWrites().flatMap(
      (call) => ((call.payload.entries as MockEntry[] | undefined) ?? []),
    )
  /** 某词所有已写 word-overlay 行（按写入顺序解析 JSON） */
  const overlaysOf = (wordId: string): Array<Record<string, unknown>> =>
    entries()
      .filter((entry) => entry.key === `word-overlay:${wordId}`)
      .map((entry) => JSON.parse(entry.json) as Record<string, unknown>)
  const errorCodeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
    try {
      await promise
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }
  return { calls, contentWrites, entries, overlaysOf, errorCodeOf }
}

/** 默认 idb 模式下先建词（避免让建库本身走 sqlite 写源） */
async function seedWord(headword = 'alpha'): Promise<{ deckId: string; wordId: string }> {
  const deck = await createDeck({
    name: 'core-sense-write',
    words: [{ headword, meanings: [{ cn: '甲' }, { cn: '阿尔法' }] }],
  })
  return { deckId: deck.id, wordId: `${deck.id}:${headword}` }
}

async function useContentSqlite(): Promise<void> {
  // C-04 后 settings 读路径 cache meta 缺失会 fail-closed 回源 SQLite（mock 无 settings）→ 写源被判 idb
  await primeLegacySqliteContentSource()
}

async function cachedWord(wordId: string) {
  return getDb().words.get(wordId)
}

beforeEach(async () => {
  await resetDatabase()
  await resetContentSourceToIdb()
})

afterEach(() => {
  setSqliteTransport(null)
})

describe('0.14 core-sense 例句写源（core-sense-examples）', () => {
  it('sqlite 成功→写 word-overlay 行并同步 IDB cache；清空同样走写源', async () => {
    const { wordId } = await seedWord()
    await useContentSqlite()
    const mock = installSqliteMock()

    const entry = await saveCoreSenseExamples(wordId, {
      coreSenseIndex: 1,
      label: '本义一',
      examples: [{ en: 'alpha example', cn: '例句' }],
      source: 'ai',
    })
    expect(entry?.label).toBe('本义一')
    expect(mock.contentWrites()).toHaveLength(1)
    const rows = mock.entries()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.key).toBe(`word-overlay:${wordId}`)
    expect(rows[0]!.kind).toBe('word-overlay')
    expect(mock.overlaysOf(wordId)[0]!.coreSenseExamples).toMatchObject([{ label: '本义一' }])
    // SQLite 成功后 IDB cache 才更新
    expect((await cachedWord(wordId))?.coreSenseExamples?.[0]?.label).toBe('本义一')
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')

    await clearCoreSenseExamples(wordId)
    const overlays = mock.overlaysOf(wordId)
    expect(overlays).toHaveLength(2)
    // 清空后的 overlay 不再包含该字段（事实源与 cache 同步删除）
    expect(overlays[1]!.coreSenseExamples).toBeUndefined()
    expect((await cachedWord(wordId))?.coreSenseExamples).toBeUndefined()
  }, 30_000)

  it('sqlite 失败→抛 ContentWriteError 且 IDB 不回写（保留旧值）', async () => {
    const { wordId } = await seedWord()
    // 先在 idb 模式写入旧值，作为失败时的对照
    await saveCoreSenseExamples(wordId, {
      coreSenseIndex: 1,
      label: '旧本义',
      examples: [{ en: 'old example', cn: '旧例句' }],
    })
    await useContentSqlite()
    const mock = installSqliteMock({ fail: true })

    const saveCode = await mock.errorCodeOf(
      saveCoreSenseExamples(wordId, {
        coreSenseIndex: 1,
        label: '新本义',
        examples: [{ en: 'new example', cn: '新例句' }],
      }),
    )
    expect(saveCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect(mock.contentWrites().length).toBeGreaterThan(0)
    expect((await cachedWord(wordId))?.coreSenseExamples?.[0]?.label).toBe('旧本义')

    const clearCode = await mock.errorCodeOf(clearCoreSenseExamples(wordId))
    expect(clearCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect((await cachedWord(wordId))?.coreSenseExamples?.[0]?.label).toBe('旧本义')
  }, 30_000)

  it('idb 模式行为不变：只写 IDB，不调用 contentWrite', async () => {
    const { wordId } = await seedWord()
    const mock = installSqliteMock()

    const entry = await saveCoreSenseExamples(wordId, {
      coreSenseIndex: 1,
      label: '本义一',
      examples: [{ en: 'alpha example', cn: '例句' }],
    })
    expect(entry).not.toBeNull()
    expect((await cachedWord(wordId))?.coreSenseExamples).toHaveLength(1)

    await clearCoreSenseExamples(wordId)
    expect((await cachedWord(wordId))?.coreSenseExamples).toBeUndefined()
    // C-04 后 idb 模式下 settings 读会合法回源 SQLite（cache meta 缺失时 fail-closed），
    // 因此只断言“不触发内容写”，而不是“零 SQLite 调用”。
    expect(mock.contentWrites()).toHaveLength(0)
  }, 30_000)
})

describe('0.14 core-sense 串联助记写源（core-sense-overview）', () => {
  it('sqlite 成功→写 word-overlay 行并同步 IDB cache；清空同样走写源', async () => {
    const { wordId } = await seedWord('beta')
    await useContentSqlite()
    const mock = installSqliteMock()

    const overview = await saveCoreSenseOverview(wordId, {
      text: 'SQLITE 串联助记',
      source: 'ai',
    })
    expect(overview.text).toBe('SQLITE 串联助记')
    expect(mock.contentWrites()).toHaveLength(1)
    expect(mock.entries()[0]!.key).toBe(`word-overlay:${wordId}`)
    expect(mock.entries()[0]!.kind).toBe('word-overlay')
    expect(mock.overlaysOf(wordId)[0]!.coreSenseOverview).toMatchObject({ text: 'SQLITE 串联助记' })
    expect((await getCoreSenseOverview(wordId))?.text).toBe('SQLITE 串联助记')

    await clearCoreSenseOverview(wordId)
    const overlays = mock.overlaysOf(wordId)
    expect(overlays).toHaveLength(2)
    expect(overlays[1]!.coreSenseOverview).toBeUndefined()
    expect(await getCoreSenseOverview(wordId)).toBeNull()
  }, 30_000)

  it('sqlite 失败→抛 ContentWriteError 且 IDB 不回写（保留旧值）', async () => {
    const { wordId } = await seedWord('beta')
    await saveCoreSenseOverview(wordId, { text: '旧助记', source: 'manual' })
    await useContentSqlite()
    const mock = installSqliteMock({ fail: true })

    const saveCode = await mock.errorCodeOf(
      saveCoreSenseOverview(wordId, { text: '新助记', source: 'ai' }),
    )
    expect(saveCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect((await getCoreSenseOverview(wordId))?.text).toBe('旧助记')

    const clearCode = await mock.errorCodeOf(clearCoreSenseOverview(wordId))
    expect(clearCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect((await getCoreSenseOverview(wordId))?.text).toBe('旧助记')
  }, 30_000)

  it('idb 模式行为不变：只写 IDB，不调用 contentWrite', async () => {
    const { wordId } = await seedWord('beta')
    const mock = installSqliteMock()

    await saveCoreSenseOverview(wordId, { text: 'IDB 串联助记', source: 'ai' })
    expect((await getCoreSenseOverview(wordId))?.text).toBe('IDB 串联助记')

    await clearCoreSenseOverview(wordId)
    expect(await getCoreSenseOverview(wordId)).toBeNull()
    expect(mock.contentWrites()).toHaveLength(0)
  }, 30_000)
})

describe('0.14 core-sense 词组写源（core-sense-phrases）', () => {
  it('sqlite 成功→写 word-overlay 行并同步 IDB cache；清空同样走写源', async () => {
    const { wordId } = await seedWord('gamma')
    await useContentSqlite()
    const mock = installSqliteMock()

    const entry = await saveCoreSensePhrases(wordId, {
      coreSenseIndex: 1,
      label: '本义一',
      phrases: [{ en: 'alpha phrase', cn: '词组' }],
      source: 'ai',
    })
    expect(entry?.label).toBe('本义一')
    expect(mock.contentWrites()).toHaveLength(1)
    expect(mock.entries()[0]!.key).toBe(`word-overlay:${wordId}`)
    expect(mock.entries()[0]!.kind).toBe('word-overlay')
    expect(mock.overlaysOf(wordId)[0]!.coreSensePhrases).toMatchObject([{ label: '本义一' }])
    expect((await cachedWord(wordId))?.coreSensePhrases?.[0]?.label).toBe('本义一')

    await clearCoreSensePhrases(wordId)
    const overlays = mock.overlaysOf(wordId)
    expect(overlays).toHaveLength(2)
    expect(overlays[1]!.coreSensePhrases).toBeUndefined()
    expect((await cachedWord(wordId))?.coreSensePhrases).toBeUndefined()
  }, 30_000)

  it('sqlite 失败→抛 ContentWriteError 且 IDB 不回写（保留旧值）', async () => {
    const { wordId } = await seedWord('gamma')
    await saveCoreSensePhrases(wordId, {
      coreSenseIndex: 1,
      label: '旧本义',
      phrases: [{ en: 'old phrase', cn: '旧词组' }],
    })
    await useContentSqlite()
    const mock = installSqliteMock({ fail: true })

    const saveCode = await mock.errorCodeOf(
      saveCoreSensePhrases(wordId, {
        coreSenseIndex: 1,
        label: '新本义',
        phrases: [{ en: 'new phrase', cn: '新词组' }],
      }),
    )
    expect(saveCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect((await cachedWord(wordId))?.coreSensePhrases?.[0]?.label).toBe('旧本义')

    const clearCode = await mock.errorCodeOf(clearCoreSensePhrases(wordId))
    expect(clearCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect((await cachedWord(wordId))?.coreSensePhrases?.[0]?.label).toBe('旧本义')
  }, 30_000)

  it('idb 模式行为不变：只写 IDB，不调用 contentWrite', async () => {
    const { wordId } = await seedWord('gamma')
    const mock = installSqliteMock()

    const entry = await saveCoreSensePhrases(wordId, {
      coreSenseIndex: 1,
      label: '本义一',
      phrases: [{ en: 'alpha phrase', cn: '词组' }],
    })
    expect(entry).not.toBeNull()
    expect((await cachedWord(wordId))?.coreSensePhrases).toHaveLength(1)

    await clearCoreSensePhrases(wordId)
    expect((await cachedWord(wordId))?.coreSensePhrases).toBeUndefined()
    expect(mock.contentWrites()).toHaveLength(0)
  }, 30_000)
})
