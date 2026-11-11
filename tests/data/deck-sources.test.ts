import './test-utils'

import { describe, expect, it } from 'vitest'

import manifest from '../../src/data/builtin/manifest.json'
import { BRAND } from '../../src/app/brand'
import { BUILTIN_DECK_IDS, DECK_SOURCES } from '../../src/data'

describe('内置词库注册表（task-58 公开版参数化）', () => {
  it('配置与 brand/manifest 一致：默认库 = BRAND.defaultDeckId，第一个 source 即默认库', () => {
    expect(DECK_SOURCES.length).toBeGreaterThan(0)
    expect([...BUILTIN_DECK_IDS]).toEqual(DECK_SOURCES.map((source) => source.deckId))
    expect(DECK_SOURCES[0]!.deckId).toBe(BRAND.defaultDeckId)
    // 私版/公开版都必须让 brand 声明的内置列表与 deck-sources 一致（sanitize 会同时替换两者）
    expect([...BRAND.builtinDeckIds]).toEqual(DECK_SOURCES.map((source) => source.deckId))
    for (const source of DECK_SOURCES) {
      const entry = manifest.decks.find((deck) => deck.key === source.key)
      expect(entry, `manifest 缺少 ${source.key}`).toBeTruthy()
      expect(entry!.deckId).toBe(source.deckId)
      expect(entry!.wordCount).toBeGreaterThan(0)
    }
  })

  it('每个配置的 deck 都能被 load() 加载并解析（懒加载 chunk 可用）', async () => {
    for (const source of DECK_SOURCES) {
      const raw = await source.load()
      expect(typeof raw).toBe('string')
      const parsed = JSON.parse(raw) as { format?: string; deck?: { id?: string } }
      expect(parsed.format).toBe('momo-builtin-deck')
      expect(parsed.deck?.id).toBe(source.deckId)
    }
  })

})
