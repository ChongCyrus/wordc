import { useLiveQuery } from 'dexie-react-hooks'
import { deriveHomeState } from '../../core'
import { getHomeStudyData, type HomeStudyData } from '../../data'

/**
 * 首页今日任务 6 态（SPEC-v2 §6.2）：
 * data.getHomeStudyData() 给事实 → core.deriveHomeState() 派生态 → UI 文案（home-state-view）。
 * plan 变化（学习页评分/退出）会被 useLiveQuery 追踪，回首页自动刷新。
 */
export function useHomeStudy() {
  const data = useLiveQuery(() => getHomeStudyData(), [])

  const homeState = data
    ? deriveHomeState({
        plan: data.plan as unknown as Parameters<typeof deriveHomeState>[0]['plan'],
        dueCount: data.dueCount,
        dailyGoal: data.dailyGoal,
        hasDeck: data.hasDeck,
        hasLearnableWord: data.hasLearnableWord,
        overdueLeft: data.overdueLeft,
      })
    : null

  return {
    data: (data ?? null) as HomeStudyData | null,
    homeState,
    loading: data === undefined,
  }
}
