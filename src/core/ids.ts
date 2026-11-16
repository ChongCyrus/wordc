/**
 * id 生成规则（SPEC §1.4，**必须一致**，否则跨端/导入导出对不上）。
 *
 * 一旦生成永不变：导入/合并/导出都靠它对齐。
 */

/** 32 位 FNV-1a（纯函数，不依赖平台；用于稳定生成短 id） */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    // hash *= 16777619（用移位避免 32 位溢出精度问题）
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/** 1) 规范化：去首尾空白 → 合并连续空白为单空格 → 小写 */
export function normalizeHeadword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 2) 词库 id（用户导入，避免中文/空格进 id） */
export function newDeckId(name: string, createdAt: number = Date.now()): string {
  if (/^[a-z0-9-]+$/.test(name)) return name
  return `deck-${fnv1a32(`${name}:${createdAt}`).toString(36)}`
}

/** 3) 单词 id：钉死为 `${deckId}:${normalizeHeadword(headword)}` */
export function wordIdOf(deckId: string, headword: string): string {
  return `${deckId}:${normalizeHeadword(headword)}`
}

/** 4) 含义 id：按数组下标从 1 开始，`${wordId}#M${i+1}` */
export function meaningIdOf(wordId: string, index1Based: number): string {
  return `${wordId}#M${index1Based}`
}

/** 词库 id 前缀检查（避免用户把别的词库词条错挂） */
export function isWordIdOfDeck(wordId: string, deckId: string): boolean {
  return wordId.startsWith(`${deckId}:`)
}

/** 从 wordId 取出 headword 部分（`deckId:` 之后） */
export function headwordOfWordId(wordId: string): string {
  const idx = wordId.indexOf(':')
  return idx >= 0 ? wordId.slice(idx + 1) : wordId
}

/** 从 meaningId 取出所属 wordId（`#M` 之前） */
export function wordIdOfMeaning(meaningId: string): string {
  const idx = meaningId.indexOf('#M')
  return idx >= 0 ? meaningId.slice(0, idx) : meaningId
}
