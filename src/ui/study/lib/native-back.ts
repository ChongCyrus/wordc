/** 原生 Android 返回键桥：MainActivity 会先调用 window.__mmHandleBack()，返回 true 表示页面已消费 */
declare global {
  interface Window {
    __mmHandleBack?: () => boolean
  }
}

export function registerNativeBack(handler: () => boolean): () => void {
  if (typeof window === 'undefined') return () => undefined
  const previous = window.__mmHandleBack
  window.__mmHandleBack = handler
  return () => {
    if (window.__mmHandleBack === handler) {
      window.__mmHandleBack = previous
    }
  }
}
