/** task-209：批量不常考应用汇总（含义/本义分开，精确） */
export function rareBatchApplySummary(appliedMeanings: number, appliedCore: number): string {
  return `已应用：含义 ${appliedMeanings} 条 · 本义 ${appliedCore} 条`
}
