import { describe, expect, it } from 'vitest'
import {
  isFirstShowOf,
  ratingLabels,
  LEGACY_LABELS,
  OFFICIAL_FIRST_LABELS,
  OFFICIAL_LATER_LABELS,
} from '../../src/ui/study/lib/rating-labels'
import {
  hasOfficialSetting,
  OFFICIAL_SETTING_DEFAULTS,
  patchOfficialBool,
  readOfficialBool,
} from '../../src/app/hooks/officialSettings'

describe('三键主标签（官方 is_first_show 切换）', () => {
  it('首次显示：认识 / 不确定 / 不认识', () => {
    expect(ratingLabels({ isFirstShow: true, labelSwitch: true })).toEqual(OFFICIAL_FIRST_LABELS)
  })

  it('之后：认识 / 模糊 / 忘记', () => {
    expect(ratingLabels({ isFirstShow: false, labelSwitch: true })).toEqual(OFFICIAL_LATER_LABELS)
  })

  it('关闭 labelSwitch：恢复旧固定文案 认识 / 模糊 / 不认识', () => {
    expect(ratingLabels({ isFirstShow: true, labelSwitch: false })).toEqual(LEGACY_LABELS)
    expect(ratingLabels({ isFirstShow: false, labelSwitch: false })).toEqual(LEGACY_LABELS)
  })

  it('isFirstShow 判定：新词（无 state / firstSeenAt=null / phase=new）为首次', () => {
    expect(isFirstShowOf(null)).toBe(true)
    expect(isFirstShowOf(undefined)).toBe(true)
    expect(isFirstShowOf({ phase: 'new', firstSeenAt: null })).toBe(true)
    expect(isFirstShowOf({ phase: 'review', firstSeenAt: 1 })).toBe(false)
    expect(isFirstShowOf({ phase: 'learning', firstSeenAt: 0 })).toBe(false)
  })
})

describe('官方设置项兼容层（task-27）', () => {
  it('默认值：labelSwitch/showPredictedInterval 开，allowVagueComplete 关', () => {
    expect(OFFICIAL_SETTING_DEFAULTS['study.labelSwitch']).toBe(true)
    expect(OFFICIAL_SETTING_DEFAULTS['memory.showPredictedInterval']).toBe(true)
    expect(OFFICIAL_SETTING_DEFAULTS['study.allowVagueComplete']).toBe(false)
  })

  it('数据层未落地 key 时：hasOfficialSetting=false，read 用默认值兜底', () => {
    const settings = { 'study.dailyGoal': 30 } as unknown as Record<string, unknown>
    expect(hasOfficialSetting(settings as never, 'study.allowVagueComplete')).toBe(false)
    expect(readOfficialBool(settings as never, 'study.allowVagueComplete')).toBe(false)
    expect(readOfficialBool(null, 'study.labelSwitch')).toBe(true)
  })

  it('数据层落地 key 后：读取真实值；patch 能构造写入对象', () => {
    const settings = { 'study.allowVagueComplete': true } as unknown as Record<string, unknown>
    expect(hasOfficialSetting(settings as never, 'study.allowVagueComplete')).toBe(true)
    expect(readOfficialBool(settings as never, 'study.allowVagueComplete')).toBe(true)
    expect(patchOfficialBool('study.allowVagueComplete', false)).toEqual({
      'study.allowVagueComplete': false,
    })
  })
})
