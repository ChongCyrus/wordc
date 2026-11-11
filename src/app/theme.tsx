import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getSettings, updateSettings } from '../data'

/**
 * 主题 / 外观渲染通道（SPEC §5 / §8.3）。
 *
 * 唯一事实来源 = data 的 settings 表（`app.theme` / `app.fontScale` / `app.reduceMotion`）；
 * 本 Provider 只负责把设置解析成 <html> 上的属性：
 *   - data-theme="light|dark"（system 解析成具体值后写入）
 *   - style="--mm-font-scale: …"
 *   - data-reduce-motion="true|false"
 *   - <meta name="theme-color"> 同步
 * 设置页只调 `updateSettings()`，本 Provider 通过 useLiveQuery 自动响应（无需手动 setMode）。
 */
export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'momo.theme'

type ThemeContextValue = {
  mode: ThemeMode
  /** 实际生效的明暗（system 已解析） */
  resolved: 'light' | 'dark'
  /** 写入 settings 表（页面上的深色开关也用这个） */
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settings = useLiveQuery(() => getSettings(), [])
  const [storedMode, setStoredMode] = useState<ThemeMode>(readStoredMode)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  const mode: ThemeMode = settings?.['app.theme'] ?? storedMode
  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
  const fontScale = settings?.['app.fontScale'] ?? 1
  const reduceMotion = settings?.['app.reduceMotion'] ?? false

  // 跟随系统明暗变化
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mql = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // data-theme：system 也解析成具体值写入（CSS 只需一份深色选择器）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.appendChild(meta)
    }
    meta.content = resolved === 'dark' ? '#101312' : '#FFFFFF'
  }, [resolved])

  // 全局字号倍数 / 减少动效
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--mm-font-scale', String(fontScale))
    root.setAttribute('data-reduce-motion', reduceMotion ? 'true' : 'false')
  }, [fontScale, reduceMotion])

  const setMode = useCallback((next: ThemeMode) => {
    setStoredMode(next)
    try {
      localStorage.setItem(STORAGE_KEY, next === 'system' ? 'system' : next)
    } catch {
      /* 隐私模式忽略 */
    }
    void updateSettings({ 'app.theme': next }).catch(() => undefined)
  }, [])

  const value = useMemo(() => ({ mode, setMode, resolved }), [mode, resolved, setMode])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme 必须在 <ThemeProvider> 内使用')
  }
  return context
}
