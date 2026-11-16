import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastKind = 'info' | 'error'

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

interface ToastContextValue {
  show: (message: string, kind?: ToastKind) => void
  error: (message: string) => void
  success: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** 全局轻提示（底部 88px；1300ms 自动消失）。页面统一 try/catch + toast.error(message)（SPEC §9.4）。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const seedRef = useRef(0)

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    if (!message) return
    seedRef.current += 1
    const id = seedRef.current
    setToasts((prev) => [...prev.slice(-2), { id, message, kind }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id))
    }, 1600)
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      error: (message: string) => show(message, 'error'),
      success: (message: string) => show(message, 'info'),
    }),
    [show],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="mm-toast-host" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`mm-toast${toast.kind === 'error' ? ' mm-toast--error' : ''}`}
            role="status"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast 必须在 <ToastProvider> 内使用')
  }
  return context
}
