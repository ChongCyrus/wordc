/**
 * 「新词顺序」设置（task-47/48）：词库顺序（默认）或随机乱序。
 *
 * - key：`study.newWordOrder`（'order' | 'random'），由 core `SettingsMap` + data 默认值提供；
 * - 切换后**当天计划不重排**（plan 创建后顺序固定；随机用 plan 稳定种子），明日/新计划生效；
 * - 数据层尚未落地 key 时 `hasNewWordOrderSetting=false`，设置页不渲染该行（避免写未知 key 报错）。
 */
import type { SettingsMap } from '../../core'
import { updateSettings } from '../../data'

export type NewWordOrder = 'order' | 'random'

export const NEW_WORD_ORDER_KEY = 'study.newWordOrder'
export const DEFAULT_NEW_WORD_ORDER: NewWordOrder = 'random'

export const NEW_WORD_ORDER_OPTIONS: ReadonlyArray<{ value: NewWordOrder; label: string }> = [
  { value: 'order', label: '词库顺序' },
  { value: 'random', label: '随机乱序' },
]

export const NEW_WORD_ORDER_HINT =
  '默认：随机乱序；当天计划创建后顺序固定，改学习量也会保持同一随机序列（明天/新计划生效）'

/** 读取该设置是否已被数据层支持（getSettings 合并默认值后应包含 key） */
export function hasNewWordOrderSetting(
  settings: SettingsMap | null | undefined,
): boolean {
  return settings != null && Object.prototype.hasOwnProperty.call(settings, NEW_WORD_ORDER_KEY)
}

/** 规范化新词顺序（非法/缺失 → 默认 random，与 data 默认值一致） */
export function parseNewWordOrder(raw: unknown): NewWordOrder {
  return raw === 'order' ? 'order' : 'random'
}

export function readNewWordOrder(settings: SettingsMap | null | undefined): NewWordOrder {
  const raw = settings
    ? (settings as unknown as Record<string, unknown>)[NEW_WORD_ORDER_KEY]
    : undefined
  return parseNewWordOrder(raw)
}

export type UpdateSettingsFn = (patch: Partial<SettingsMap>) => Promise<unknown>

/**
 * 保存新词顺序：非法值直接抛错且**不写设置**；合法值透传给 updateSettings。
 * （update 可注入，便于单测 mock 断言。）
 */
export async function saveNewWordOrder(
  value: string,
  update: UpdateSettingsFn = updateSettings,
): Promise<NewWordOrder> {
  if (value !== 'order' && value !== 'random') {
    throw new Error(`新词顺序值不合法：${value}`)
  }
  await update({ [NEW_WORD_ORDER_KEY]: value } as unknown as Partial<SettingsMap>)
  return value
}
