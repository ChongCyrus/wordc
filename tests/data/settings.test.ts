import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { BRAND } from '../../src/app/brand'

import {
  getSettings,
  getSetting,
  getDb,
  isSettingKey,
  normalizeSettingValue,
  resetDatabase,
  resetSettings,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  settingOrDefault,
  updateSettings,
} from '../../src/data'
import { ensureBuiltinDecks } from '../../src/data'

beforeEach(async () => {
  await resetDatabase()
})

describe('设置项默认值（SPEC §5，AC4）', () => {
  it('全部设置 key 与其默认值（20 + task-70 AI 10 项 + task-80 jsonMode = 31 项）', async () => {
    expect(SETTING_KEYS).toHaveLength(31)
    const settings = await getSettings()
    expect(settings['study.dailyGoal']).toBe(30)
    expect(settings['board.exampleCount']).toBe(2)
    expect(settings['board.showPhonetic']).toBe(true)
    expect(settings['memory.totalRepeats']).toBe(3)
    expect(settings['memory.mode']).toBe('sequential')
    expect(settings['memory.showPhrases']).toBe(true) // D47 修订：用户要求默认显示词组
    expect(settings['memory.fontScale']).toBe(1)
    expect(settings['app.theme']).toBe('system')
    expect(settings['app.reduceMotion']).toBe(false)
    // task-27（官方前端行为）
    expect(settings['study.labelSwitch']).toBe(true)
    expect(settings['memory.showPredictedInterval']).toBe(true)
    expect(settings['study.allowVagueComplete']).toBe(false)
    expect(settings['study.newWordOrder']).toBe('random') // task-47：默认随机打乱新词
    expect(settings['study.dailyReviewCap']).toBe(0) // task-51：默认不限复习上限
    // task-70 AI 内容生成（默认关）
    expect(settings['ai.enabled']).toBe(false)
    expect(settings['ai.provider']).toBe('deepseek')
    expect(settings['ai.baseUrl']).toBe('https://api.deepseek.com')
    expect(settings['ai.model']).toBe('deepseek-chat')
    expect(settings['ai.apiKey']).toBe('')
    expect(settings['ai.keyStorage']).toBe('persistent')
    expect(settings['ai.transport']).toBe('auto')
    expect(settings['ai.batchSize']).toBe(20)
    expect(settings['ai.maxCostPerRun']).toBe(3)
    expect(settings['ai.pregenBudget']).toBe(40)
    expect(settings['ai.jsonMode']).toBe(true) // task-80：默认发送 response_format
    expect(settings['data.maimemoToken']).toBe('')
    expect(settings['data.proxyUrl']).toBe('http://127.0.0.1:8787')
    expect(settings['data.selectedDeckId']).toBe(BRAND.defaultDeckId)
    expect(settings).toEqual(SETTINGS_DEFAULTS)
  })

  it('写后读回；未写过的 key 用默认值', async () => {
    await updateSettings({ 'study.dailyGoal': 50 })
    const settings = await getSettings()
    expect(settings['study.dailyGoal']).toBe(50)
    expect(settings['memory.mode']).toBe('sequential')
    expect(settings['memory.showPhrases']).toBe(true) // D47 修订：用户要求默认显示词组
    expect(await getSetting('study.dailyGoal')).toBe(50)
    expect(await getSetting('app.theme')).toBe('system')
  })
})

describe('越界值 clamp / 非法值拒绝（AC4）', () => {
  it('数字 clamp 到区间并按步长取整（dailyGoal 除外：越界拒绝，见下）', async () => {
    await updateSettings({
      'study.dailyGoal': 999,
      'memory.fontScale': 5,
      'memory.cardSize': 0.1,
      'board.exampleCount': 9,
      'memory.totalRepeats': 0,
    })
    const settings = await getSettings()
    expect(settings['study.dailyGoal']).toBe(999) // 1–9999 任意正整数，不卡 200
    expect(settings['memory.fontScale']).toBe(1.6)
    expect(settings['memory.cardSize']).toBe(0.8)
    expect(settings['board.exampleCount']).toBe(3)
    expect(settings['memory.totalRepeats']).toBe(1)
  })

  it('步长 0.05 取整（1.03 → 1.05）', () => {
    expect(normalizeSettingValue('memory.fontScale', 1.03)).toBe(1.05)
    expect(normalizeSettingValue('memory.fontScale', 1.02)).toBe(1)
    expect(normalizeSettingValue('study.dailyGoal', 30.7)).toBeUndefined() // 小数拒绝
    expect(normalizeSettingValue('study.dailyGoal', 201)).toBe(201)
    expect(normalizeSettingValue('memory.mode', 'random')).toBe('random')
    expect(normalizeSettingValue('memory.mode', 'other')).toBeUndefined()
    expect(normalizeSettingValue('board.showPhonetic', 'false')).toBe(false)
    expect(normalizeSettingValue('data.proxyUrl', 'not-a-url')).toBeUndefined()
    expect(normalizeSettingValue('data.proxyUrl', '')).toBe('')
  })

  it('新词顺序：默认 random，仅允许 order/random，非法值回退', async () => {
    expect(normalizeSettingValue('study.newWordOrder', 'order')).toBe('order')
    expect(normalizeSettingValue('study.newWordOrder', 'random')).toBe('random')
    expect(normalizeSettingValue('study.newWordOrder', 'bad')).toBeUndefined()
    expect(settingOrDefault('study.newWordOrder', 'bad')).toBe('random')
    await updateSettings({ 'study.newWordOrder': 'order' })
    expect((await getSettings())['study.newWordOrder']).toBe('order')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(updateSettings({ 'study.newWordOrder': 'bad' } as any)).rejects.toThrow(/不合法/)
  })

  it('每日复习上限：0=不限，1–9999 合法；越界/小数/字符串/负数拒绝', async () => {
    expect(normalizeSettingValue('study.dailyReviewCap', 0)).toBe(0)
    expect(normalizeSettingValue('study.dailyReviewCap', 50)).toBe(50)
    expect(normalizeSettingValue('study.dailyReviewCap', 9999)).toBe(9999)
    for (const invalid of [-1, 10000, 2.5, Number.NaN, '50']) {
      expect(normalizeSettingValue('study.dailyReviewCap', invalid)).toBeUndefined()
    }
    expect(settingOrDefault('study.dailyReviewCap', -1)).toBe(0)
    await updateSettings({ 'study.dailyReviewCap': 50 })
    expect((await getSettings())['study.dailyReviewCap']).toBe(50)
    await updateSettings({ 'study.dailyReviewCap': 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(updateSettings({ 'study.dailyReviewCap': -1 } as any)).rejects.toThrow(/不合法/)
  })

  it('非法枚举/未知 key 抛错', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(updateSettings({ 'memory.mode': 'other' } as any)).rejects.toThrow(/不合法/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(updateSettings({ 'unknown.key': 1 } as any)).rejects.toThrow(/未知设置项/)
    await expect(updateSettings({ 'data.proxyUrl': 'ftp://x' })).rejects.toThrow(/不合法/)
  })

  it('每日学习量任意设定：1–9999 合法，0/负/小数/字符串拒绝（task-24）', async () => {
    for (const value of [5, 30, 200, 201, 9999]) {
      await updateSettings({ 'study.dailyGoal': value })
      expect((await getSettings())['study.dailyGoal']).toBe(value)
      expect(normalizeSettingValue('study.dailyGoal', value)).toBe(value)
    }
    for (const invalid of [0, -1, 10000, 30.5, Number.NaN]) {
      expect(normalizeSettingValue('study.dailyGoal', invalid)).toBeUndefined()
      await expect(updateSettings({ 'study.dailyGoal': invalid })).rejects.toThrow(/不合法/)
    }
    // 数字字符串也拒绝（strictType）
    expect(normalizeSettingValue('study.dailyGoal', '30')).toBeUndefined()
    // 读库兜底：非法旧值回落默认 30
    expect(settingOrDefault('study.dailyGoal', 0)).toBe(30)
    expect(settingOrDefault('study.dailyGoal', 9999)).toBe(9999)
  })

  it('data.selectedDeckId 必须存在（写时校验）', async () => {
    await ensureBuiltinDecks()
    await updateSettings({ 'data.selectedDeckId': 'kaoyan-2027-dagang' })
    expect((await getSettings())['data.selectedDeckId']).toBe('kaoyan-2027-dagang')
    await expect(updateSettings({ 'data.selectedDeckId': 'no-such-deck' })).rejects.toThrow(/词库不存在/)
  }, 120_000)

  it('isSettingKey / settingOrDefault 兜底', () => {
    expect(isSettingKey('app.theme')).toBe(true)
    expect(isSettingKey('nope')).toBe(false)
    expect(settingOrDefault('app.theme', 'purple')).toBe('system')
    expect(settingOrDefault('study.dailyGoal', 'abc')).toBe(30)
  })

  it('resetSettings 恢复默认', async () => {
    await updateSettings({ 'app.theme': 'dark', 'study.dailyGoal': 12 })
    expect((await getSettings())['app.theme']).toBe('dark')
    await resetSettings()
    expect(await getSettings()).toEqual(SETTINGS_DEFAULTS)
    expect(await getDb().settings.count()).toBe(0)
  })
})
