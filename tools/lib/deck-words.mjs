/**
 * 内置 deck（紧凑列式）解析 helper（CLI/测试共用）。
 *
 * 含义拆分口径（task-78 修正）：
 * 1) 先按换行 `\n` 拆（受限商业词表每行带词性，eg "n. 拥抱\nvt. 信奉，皈依"）；
 * 2) 每行再按中文/英文分号 `；;` 拆义项；
 * 3) `、`、`，`、`/`、`|` 视为同义并列，**不拆**（与 task-16 语义拆分规则一致）。
 * 验证：受限商业词表 6702 词 = 28777 c；必考词 1893 词 = 8845 c。
 */

export function splitMeanings(text, opts = {}) {
  const sep = opts.splitDunhao ? /[、；;]+/ : /[；;]+/
  return String(text ?? '')
    .split(/\n+/)
    .flatMap((line) => line.split(sep))
    .map((cn) => cn.trim())
    .filter(Boolean)
    .slice(0, 12)
}

export function columnIndex(columns) {
  return new Map((Array.isArray(columns) ? columns : []).map((name, i) => [name, i]))
}

/** 解析紧凑 deck 为 [{headword, headwordLower, order, chapter, meanings:[cn]}]（不依赖 App 代码） */
export function decodeDeckWords(deckJson, opts = {}) {
  const columns = columnIndex(deckJson.columns)
  const read = (row, name) => (columns.has(name) ? row[columns.get(name)] : undefined)
  const words = []
  for (let i = 0; i < (Array.isArray(deckJson.words) ? deckJson.words.length : 0); i += 1) {
    const row = deckJson.words[i]
    const headword = String(read(row, 'term') ?? '').trim()
    if (!headword) continue
    let meanings = splitMeanings(read(row, 'meaning'), opts).map((cn, k) => ({
      id: `${String(deckJson?.deck?.id ?? 'deck')}:${headword.toLowerCase()}#M${k + 1}`,
      cn,
    }))
    // 与 App buildWord 一致：无释义时用 headword 兜底为 1 个 c（不丢词）
    if (meanings.length === 0) {
      meanings = [{ id: `${String(deckJson?.deck?.id ?? 'deck')}:${headword.toLowerCase()}#M1`, cn: headword }]
    }
    words.push({
      headword,
      headwordLower: headword.toLowerCase(),
      order: Number(read(row, 'order')) || i + 1,
      chapter: String(read(row, 'chapter') ?? ''),
      meanings,
    })
  }
  words.sort((a, b) => a.order - b.order)
  return words
}
