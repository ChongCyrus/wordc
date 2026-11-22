import type { ReactNode } from 'react'
import { ThemeProvider } from './theme'
import { ToastProvider } from './toast'

/** 全局 Provider 汇总：主题渲染通道 + 轻提示。数据读取走 src/app/hooks/ 的 hooks。 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}
