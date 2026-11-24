/**
 * 评分提交的分支选择（task-44）：
 * - 回退浏览上一词（browseBack=true）→ 调 `reRateInPlan`（撤销旧评分 + 按新评分重评，即「改判」）；
 * - 正常学习 → 调 `rateInPlan`。
 * 把分支抽成可注入依赖的纯函数，便于 tests/ui mock 断言「点击评分键会调用 reRateInPlan」。
 */
import type { Rating } from '../components/types'

export type RateSubmitMode = 'browse-rerate' | 'normal-rate'

export interface RateSubmitArgs {
  wordId: string
  rating: Rating
  planId?: string
  now?: number
}

export interface RateSubmitDeps<T> {
  rate: (args: RateSubmitArgs) => Promise<T>
  reRate: (args: RateSubmitArgs) => Promise<T>
}

/** 决定本次点评分应走哪个 data 函数（纯函数） */
export function decideRateSubmit(input: { browseBack: boolean }): RateSubmitMode {
  return input.browseBack ? 'browse-rerate' : 'normal-rate'
}

/** 按模式提交评分：browseBack → reRateInPlan，否则 rateInPlan */
export async function submitRatingByMode<T>(
  input: RateSubmitArgs & { browseBack: boolean },
  deps: RateSubmitDeps<T>,
): Promise<T> {
  const args: RateSubmitArgs = { wordId: input.wordId, rating: input.rating }
  if (input.planId !== undefined) args.planId = input.planId
  if (input.now !== undefined) args.now = input.now
  return decideRateSubmit(input) === 'browse-rerate' ? deps.reRate(args) : deps.rate(args)
}
