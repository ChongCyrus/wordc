/**
 * 学习效率 / 剩余时间估算（F3，0.3.35）—— **纯函数**，不依赖 UI/存储。
 *
 * 数据来源（由 UI / data 层提供）：
 * - 今日活跃学习时长：进入学习 → 离开/评分的时间差累计（息屏/后台由 UI 暂停计时，不计入）
 * - 今日已学词数：今日已完成学习的单词数
 * - 今日剩余词数：待复习 + 待新学（由队列/计划层计算）
 *
 * 公式：
 *   averageSecondsPerWord = activeStudyMs / 1000 / learnedWords   （learnedWords=0 → null）
 *   estimatedRemainingSeconds = averageSecondsPerWord × remainingWords （0 剩余 → 0）
 *
 * UI 展示：0 词时显示「—」（不显示 0/0）；剩余为 null（无数据）时也显示「—」。
 */

/** 单次学习活跃时长（进入学习→评分/离开）；非法/负数收敛为 0 */
export function activeStudyMs(startedAt: number, endedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0
  return Math.max(0, endedAt - startedAt)
}

/** 累加今日活跃时长（读取旧值 + 本次区间的时长；非法旧值按 0） */
export function accumulateActiveStudyMs(totalMs: number, startedAt: number, endedAt: number): number {
  const current = Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0
  return current + activeStudyMs(startedAt, endedAt)
}

/** 平均每词学习秒数；今日 0 词 → null（UI 显示「—」） */
export function averageSecondsPerWord(activeStudyMs: number, learnedWords: number): number | null {
  if (!Number.isFinite(learnedWords) || learnedWords <= 0) return null
  const active = Number.isFinite(activeStudyMs) ? Math.max(0, activeStudyMs) : 0
  return active / 1000 / Math.floor(learnedWords)
}

/** 预计还需多久学完今日单词（秒）；剩余 0 → 0；无平均（0 已学词）→ null */
export function estimateRemainingStudySeconds(
  activeStudyMs: number,
  learnedWords: number,
  remainingWords: number,
): number | null {
  const remaining = Number.isFinite(remainingWords) ? Math.max(0, Math.floor(remainingWords)) : 0
  if (remaining === 0) return 0
  const average = averageSecondsPerWord(activeStudyMs, learnedWords)
  if (average == null) return null
  return average * remaining
}

export interface LearningEfficiencyInput {
  /** 今日活跃学习时长（ms） */
  activeStudyMs: number
  /** 今日已学词数（0 表示无数据） */
  learnedWords: number
  /** 今日剩余词数（待复习 + 待新学） */
  remainingWords: number
}

export interface LearningEfficiency {
  /** 平均每词秒数；learnedWords=0 → null */
  averageSecondsPerWord: number | null
  /** 预计剩余秒数；0 剩余 → 0；无平均 → null */
  estimatedRemainingSeconds: number | null
}

/** 组合计算（首页 KPI 用）；所有异常输入均安全收敛，不抛错 */
export function computeLearningEfficiency(input: LearningEfficiencyInput): LearningEfficiency {
  return {
    averageSecondsPerWord: averageSecondsPerWord(input.activeStudyMs, input.learnedWords),
    estimatedRemainingSeconds: estimateRemainingStudySeconds(
      input.activeStudyMs,
      input.learnedWords,
      input.remainingWords,
    ),
  }
}

/** 秒 → 分钟（UI 展示用；null → null；向上取整到 0.1 分钟避免「0 分钟」） */
export function secondsToMinutes(seconds: number | null | undefined): number | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  return Math.max(0, seconds) / 60
}
