import { describe, expect, it } from 'vitest'
import {
  SQLITE_FEATURE_UNAVAILABLE_MESSAGE,
  describeUiFailure,
  isExplicitSuccess,
  isUnsupportedFeatureError,
} from '../../src/app/utils/ui-feedback'

describe('task-321 B 批次 fail-closed UI 文案', () => {
  it('未移植/SQLite 不可用提示，不假成功', () => {
    expect(isUnsupportedFeatureError(Object.assign(new Error('x'), { code: 'E_UNSUPPORTED' }))).toBe(true)
    expect(isUnsupportedFeatureError(new Error('该入口未移植'))).toBe(true)
    expect(describeUiFailure(new Error('磁盘已满'), '创建计划')).toBe('创建计划失败：磁盘已满')
    expect(describeUiFailure(new Error('SQLite 不可用'), '统计')).toBe(SQLITE_FEATURE_UNAVAILABLE_MESSAGE)
    expect(isExplicitSuccess({ ok: true })).toBe(true)
    expect(isExplicitSuccess({ ok: false })).toBe(false)
    expect(isExplicitSuccess(undefined)).toBe(false)
  })
})
