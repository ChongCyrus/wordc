/** task-229：导出统计词数按唯一 wordId（senses ∪ words），不是 file.words.length（仅含 overview 词） */
export function countCoreSenseExportStats(file: {
  words: Array<{ wordId: string }>
  senses: Array<{ wordId: string; mnemonic?: { text?: string } }>
}): { words: number; senses: number; withMnemonic: number; pending: number } {
  const wordIds = new Set<string>()
  for (const word of file.words) if (word.wordId) wordIds.add(word.wordId)
  for (const sense of file.senses) if (sense.wordId) wordIds.add(sense.wordId)
  const senses = file.senses.length
  const withMnemonic = file.senses.filter((sense) => Boolean(sense.mnemonic?.text?.trim())).length
  return { words: wordIds.size, senses, withMnemonic, pending: senses - withMnemonic }
}
