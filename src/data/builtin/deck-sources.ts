/**
 * 内置词库注册表（公开版：只保留 2027 考研大纲词库）。
 *
 * 受限商业词表不随仓库分发；如需使用请通过「导入词库」导入自己的词表。
 */
export interface DeckSource {
  /** 构建产物 manifest 里的 key */
  key: string
  /** 词库 id（Deck.id） */
  deckId: string
  /** 加载紧凑列式 JSON 原文（动态 import） */
  load: () => Promise<string>
}

export const DECK_SOURCES: readonly DeckSource[] = [
  {
    key: 'dagang',
    deckId: 'kaoyan-2027-dagang',
    load: async () => (await import('./kaoyan-2027-dagang.deck.json?raw')).default,
  },
]
