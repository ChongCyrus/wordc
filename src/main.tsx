import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { installGlobalErrorLogging } from './app/ErrorBoundary'
import { APP_VERSION } from './app/version'
import { guardServiceWorkerVersion } from './app/swUpdate'
import './app/styles/global.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root 挂载点缺失，检查 index.html')
}

installGlobalErrorLogging()

// 旧 SW + 新 HTML 混用会导致 React #310 黑屏：版本变化时自动清 SW/Cache 并重载一次
void guardServiceWorkerVersion({
  version: APP_VERSION,
  storage: window.localStorage,
  hasController: Boolean(navigator.serviceWorker?.controller),
  unregisterAll: async () => {
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
    await Promise.all(registrations.map((registration) => registration.unregister()))
  },
  clearCaches: async () => {
    if (typeof caches === 'undefined') return
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
  },
  reload: () => window.location.reload(),
}).then((state) => {
  if (state === 'reloaded') return
  if ('serviceWorker' in navigator) {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        void updateSW(true)
      },
    })
  }
})

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
