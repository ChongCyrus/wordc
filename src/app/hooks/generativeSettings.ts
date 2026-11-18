/** B：生成式记忆设置（本机 UI 偏好；localStorage，避免新增数据键迁移） */
export interface GenerativeSettings {
  clicks: number
  perScreen: number
  rootFontScale: number
  showMermaid: boolean
}

export const GENERATIVE_SETTINGS_KEY = 'mm.generativeSettings'
export const DEFAULT_GENERATIVE_SETTINGS: GenerativeSettings = {
  clicks: 3,
  perScreen: 2,
  rootFontScale: 1,
  showMermaid: true,
}

export function clampGenerativeSettings(patch?: Partial<GenerativeSettings> | null): GenerativeSettings {
  const clicks = Number.isFinite(patch?.clicks) ? Math.round(patch!.clicks!) : DEFAULT_GENERATIVE_SETTINGS.clicks
  const perScreen = Number.isFinite(patch?.perScreen) ? Math.round(patch!.perScreen!) : DEFAULT_GENERATIVE_SETTINGS.perScreen
  const rootFontScale = Number.isFinite(patch?.rootFontScale) ? patch!.rootFontScale! : DEFAULT_GENERATIVE_SETTINGS.rootFontScale
  return {
    clicks: Math.min(10, Math.max(1, clicks)),
    perScreen: Math.min(5, Math.max(1, perScreen)),
    rootFontScale: Math.min(1.6, Math.max(0.8, rootFontScale)),
    showMermaid: patch?.showMermaid !== false,
  }
}

export function readGenerativeSettings(): GenerativeSettings {
  try {
    const raw = localStorage.getItem(GENERATIVE_SETTINGS_KEY)
    return clampGenerativeSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return DEFAULT_GENERATIVE_SETTINGS
  }
}

export function saveGenerativeSettings(patch: Partial<GenerativeSettings>): GenerativeSettings {
  const next = clampGenerativeSettings({ ...readGenerativeSettings(), ...patch })
  try {
    localStorage.setItem(GENERATIVE_SETTINGS_KEY, JSON.stringify(next))
  } catch {
    undefined
  }
  return next
}
