/** task-197 边界：记忆 session 的 c 过滤；若全部 c 都是「不常考」，回退全部，避免 0 个 c 的 session。 */
export function meaningsForMemory<T extends { id: string }>(
  meanings: readonly T[],
  rareMeaningIds: readonly string[] | undefined,
  hideRareMeanings: boolean,
): T[] {
  const all = [...meanings]
  if (!hideRareMeanings || all.length === 0) return all
  const rare = new Set(rareMeaningIds ?? [])
  const filtered = all.filter((meaning) => !rare.has(meaning.id))
  return filtered.length > 0 ? filtered : all
}
