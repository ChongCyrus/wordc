import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { SettingsMap } from '../../core'
import { getSettings, updateSettings, type AppSettings } from '../../data'

/**
 * 设置（SPEC §5 / §8.3）：settings 表为唯一事实来源，useLiveQuery 自动响应。
 * 读取时与默认值合并由 data 层负责；这里只做 UI 便捷封装。
 */
export function useSettings() {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1)
    window.addEventListener('momo:settings-updated', refresh)
    return () => window.removeEventListener('momo:settings-updated', refresh)
  }, [])
  const settings = useLiveQuery(() => getSettings(), [version])

  const update = useCallback(async (patch: Partial<SettingsMap>): Promise<AppSettings> => {
    return updateSettings(patch)
  }, [])

  return {
    settings,
    /** settings 尚未加载完成 */
    loading: settings === undefined,
    update,
  }
}

/** 读取单个设置（带兜底值） */
export function useSettingValue<K extends keyof SettingsMap>(
  key: K,
  fallback: SettingsMap[K],
): SettingsMap[K] {
  const { settings } = useSettings()
  return settings?.[key] ?? fallback
}
