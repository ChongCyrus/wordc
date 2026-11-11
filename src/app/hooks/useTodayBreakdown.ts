import { useLiveQuery } from 'dexie-react-hooks'
import { getTodayBreakdown, type TodayBreakdown } from '../../data'
import {
  EMPTY_TODAY_BREAKDOWN,
  type TodayBreakdownView,
} from '../../ui/today/today-types'

/**
 * 「今日单词」数据（task-49：data.getTodayBreakdown + HomeStudyData.breakdown）。
 * 数据接口未落地前返回空 breakdown（页面显示空态）；落地后自动映射，无需改页面。
 */
export function useTodayBreakdown() {
  // useLiveQuery 内部 await plans/states/words，评分后自动刷新（task-49）
  const data = useLiveQuery(() => getTodayBreakdown(), [])
  const breakdown =
    data != null ? (data as unknown as TodayBreakdownView) : EMPTY_TODAY_BREAKDOWN
  return {
    breakdown,
    loading: data === undefined,
    hasPlan: (data as TodayBreakdown | undefined)?.planId != null,
  }
}
