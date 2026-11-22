/**
 * task-137/F3：首页学习效率数据源。
 *
 * 纯算法由 core.learning-efficiency 提供；本 hook 只负责「今日活跃学习时长」：
 * - 目前从 reviewLogs 的评分时间戳估算：相邻两次评分间隔计入活跃时间，单段最多计 5 分钟（排除长时间挂机/离开）；
 * - 学习页未来写入精确 activeMs 后，可替换 estimateActiveStudyMsFromLogs 的数据源，UI/公式不变。
 */
import { useEffect, useState } from 'react'
import { computeLearningEfficiency } from '../../core'
import { getDb } from '../../data'

const MAX_GAP_MS = 5 * 60 * 1000

/** 评分时间戳 → 估算活跃毫秒（排序后相邻间隔，单段 ≤5 分钟） */
export function estimateActiveStudyMsFromLogs(timestamps: number[]): number {
  const sorted = [...timestamps].filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length < 2) return 0
  let total = 0
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i]! - sorted[i - 1]!
    if (gap > 0) total += Math.min(gap, MAX_GAP_MS)
  }
  return total
}

export function useLearningEfficiency(input: { learnedWords: number; remainingWords: number }): {
  averageSecondsPerWord: number | null
  estimatedRemainingSeconds: number | null
  activeStudyMs: number | null
} {
  const [activeStudyMs, setActiveStudyMs] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const now = new Date()
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        const rows = await getDb()
          .reviewLogs.where('reviewedAt')
          .between(startOfDay, Date.now(), true, true)
          .toArray()
        if (cancelled) return
        const stamps = rows.map((row) => row.reviewedAt)
        setActiveStudyMs(stamps.length >= 2 ? estimateActiveStudyMsFromLogs(stamps) : null)
      } catch {
        if (!cancelled) setActiveStudyMs(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [input.learnedWords])
  if (activeStudyMs == null) {
    return { averageSecondsPerWord: null, estimatedRemainingSeconds: null, activeStudyMs: null }
  }
  const result = computeLearningEfficiency({
    activeStudyMs,
    learnedWords: input.learnedWords,
    remainingWords: input.remainingWords,
  })
  return { ...result, activeStudyMs }
}
