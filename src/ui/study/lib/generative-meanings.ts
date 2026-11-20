/** task-210：生成式阶段3 c 列表过滤 rare c；全被过滤时回退全部避免空阶段；nc 不受影响（另行传入） */
export function generativeMeaningsForStage3<T extends { meaningId: string }>(
  meanings: readonly T[],
  rareMeaningIds: readonly string[],
  hideRareBlocks: boolean,
): T[] {
  if (!hideRareBlocks) return [...meanings]
  const rare = new Set(rareMeaningIds)
  const filtered = meanings.filter((meaning) => !rare.has(meaning.meaningId))
  return filtered.length > 0 ? filtered : [...meanings]
}
