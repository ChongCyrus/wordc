/**
 * 官方设置项 key 的兼容层（task-27）。
 *
 * 官方新增设置（预计复习间隔 / 允许模糊完成复习 / 三键标签切换）由 core `SettingsMap` +
 * data `SETTINGS_DEFAULTS` 提供；在数据层落地前，本文件让 UI 可以：
 * - 用 `hasOfficialSetting` 判断 key 是否已可用（未落地时不渲染控件，避免写库报「未知设置项」）；
 * - 已可用时按默认值读取、按 `Partial<SettingsMap>` 写回（类型随 core 更新自动对齐）。
 */
import type { SettingsMap } from '../../core'

export type OfficialSettingKey =
  | 'study.labelSwitch'
  | 'memory.showPredictedInterval'
  | 'study.allowVagueComplete'

export const OFFICIAL_SETTING_DEFAULTS: Record<OfficialSettingKey, boolean> = {
  /** true=官方按 is_first_show 切换标签；false=恢复旧固定文案 */
  'study.labelSwitch': true,
  /** 三键副标题是否显示「N 天后」预计复习间隔 */
  'memory.showPredictedInterval': true,
  /** 是否允许「模糊」完成当日复习（官方默认不允许） */
  'study.allowVagueComplete': false,
}

export const OFFICIAL_SETTING_META: Record<
  OfficialSettingKey,
  { label: string; hint: string }
> = {
  'study.labelSwitch': {
    label: '三键官方文案',
    hint: '开：首次「认识/不确定/不认识」、之后「认识/模糊/忘记」；关：固定旧文案',
  },
  'memory.showPredictedInterval': {
    label: '显示预计复习间隔',
    hint: '关：三键副标题只显示「今日」/进度，不显示 N 天后',
  },
  'study.allowVagueComplete': {
    label: '允许模糊完成复习',
    hint: '开：模糊可在满足次数后完成；关（官方默认）：模糊持续到认识',
  },
}

/** 该设置项是否已被 core/data 支持（settings 合并默认值后应包含 key） */
export function hasOfficialSetting(
  settings: SettingsMap | null | undefined,
  key: OfficialSettingKey,
): boolean {
  return settings != null && Object.prototype.hasOwnProperty.call(settings, key)
}

/** 读取官方布尔设置（未落地/脏值用默认值兜底） */
export function readOfficialBool(
  settings: SettingsMap | null | undefined,
  key: OfficialSettingKey,
): boolean {
  const raw = settings ? (settings as unknown as Record<string, unknown>)[key] : undefined
  return typeof raw === 'boolean' ? raw : OFFICIAL_SETTING_DEFAULTS[key]
}

/** 构造 updateSettings 的 patch（key 未在 SettingsMap 中时不失类型安全地延后） */
export function patchOfficialBool(
  key: OfficialSettingKey,
  value: boolean,
): Partial<SettingsMap> {
  return { [key]: value } as unknown as Partial<SettingsMap>
}
