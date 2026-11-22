import { useLiveQuery } from 'dexie-react-hooks'
import type { DailyStatPoint } from '../../core'
import {
  getDailyStats,
  getStatsOverview,
  getUnfamiliarTop,
  type AppStatsOverview,
  type UnfamiliarTopDetail,
} from '../../data'

/** 统计概览（今日/累计/连续打卡/反馈分布/到期压力） */
export function useStatsOverview() {
  const overview = useLiveQuery(() => getStatsOverview(), [])
  return {
    overview: overview as AppStatsOverview | undefined,
    loading: overview === undefined,
  }
}

/** 近 N 天学习量（默认 14 天） */
export function useDailyStats(days = 14) {
  const points = useLiveQuery(() => getDailyStats(days), [days])
  return { points: (points ?? []) as DailyStatPoint[], loading: points === undefined }
}

/** 不熟悉度最高的含义 Top N（默认 5） */
export function useUnfamiliarTop(limit = 5) {
  const items = useLiveQuery(() => getUnfamiliarTop(limit), [limit])
  return {
    items: (items ?? []) as UnfamiliarTopDetail[],
    loading: items === undefined,
  }
}
