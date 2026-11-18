/**
 * APK 原生桥接（由 arch 的 WebView 壳注入；浏览器/PWA 下不存在）。
 *
 * 协议（task-32 定死）：
 *   window.MomoBridge.isNativeApp(): string  → 'momo-apk'
 *   window.MomoBridge.saveBase64File(fileName, mime, base64): string
 *     → 'ok:<绝对路径>' | 'err:<原因>'
 */
export {}

declare global {
  interface MomoBridgeApi {
    isNativeApp?: () => string
    saveBase64File?: (fileName: string, mime: string, base64: string) => string
  }

  interface Window {
    MomoBridge?: MomoBridgeApi
  }
}
