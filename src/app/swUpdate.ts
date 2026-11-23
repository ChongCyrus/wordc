/** 版本变化时清理旧 Service Worker/Cache，避免旧 chunk 与新 HTML 混用（React #310 黑屏） */
export const SW_VERSION_KEY = 'mm.appVersion'

export interface SwUpdateDeps {
  version: string
  storage: Pick<Storage, 'getItem' | 'setItem'>
  hasController: boolean
  unregisterAll: () => Promise<void>
  clearCaches: () => Promise<void>
  reload: () => void
}

export async function guardServiceWorkerVersion(
  deps: SwUpdateDeps,
): Promise<'reloaded' | 'current' | 'no-controller'> {
  if (!deps.hasController) {
    try {
      deps.storage.setItem(SW_VERSION_KEY, deps.version)
    } catch {
      undefined
    }
    return 'no-controller'
  }
  let stored: string | null = null
  try {
    stored = deps.storage.getItem(SW_VERSION_KEY)
  } catch {
    stored = null
  }
  if (stored === deps.version) return 'current'
  try {
    deps.storage.setItem(SW_VERSION_KEY, deps.version)
  } catch {
    undefined
  }
  await Promise.all([deps.unregisterAll().catch(() => undefined), deps.clearCaches().catch(() => undefined)])
  deps.reload()
  return 'reloaded'
}
