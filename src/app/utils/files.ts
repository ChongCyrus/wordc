/**
 * 文件导出 / 读取统一入口（Web + APK WebView 桥接）。
 *
 * 导出：
 * - APK（arch 的 WebView 壳注入 `window.MomoBridge`）：内容转 base64 →
 *   `saveBase64File(name, mime, base64)`，返回 `ok:<绝对路径>` / `err:<原因>`；
 *   **不触发 blob 下载**。
 * - 浏览器 / PWA：保持 blob + `<a download>`。
 * 导入：
 * - 一律使用标准 `<input type="file">`（APK 走 WebView 原生文件选择；不用 showOpenFilePicker
 *   等专有 API），由 `pickTextFile()` 统一弹出。
 * - 文件名带日期（APK 与 Web 一致）。
 */

import { BRAND } from '../brand'

/** APK 内保存目录（与 arch 的壳约定；用于 toast 文案） */
/** 导出目录显示名（task-57：来自品牌配置，公开版随 BRAND 覆盖） */
export const EXPORT_FOLDER_LABEL = BRAND.exportFolderLabel

export interface SaveFileResult {
  /** native=APK 桥接保存；browser=浏览器下载；error=桥接返回错误 */
  mode: 'native' | 'browser' | 'error'
  fileName: string
  /** APK 返回的绝对路径 */
  path?: string
  error?: string
}

function getBridge(): Window['MomoBridge'] | undefined {
  if (typeof window === 'undefined') return undefined
  return window.MomoBridge
}

/** 当前是否运行在 APK WebView（原生桥接可用） */
export function isNativeApk(): boolean {
  const bridge = getBridge()
  try {
    return bridge?.isNativeApp?.() === 'momo-apk'
  } catch {
    return false
  }
}

/** 标准 base64 编码（浏览器 / Node 均可用，不依赖 btoa） */
export function bytesToBase64(bytes: Uint8Array): string {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index] ?? 0
    const hasByte2 = index + 1 < bytes.length
    const hasByte3 = index + 2 < bytes.length
    const byte2 = hasByte2 ? (bytes[index + 1] ?? 0) : 0
    const byte3 = hasByte3 ? (bytes[index + 2] ?? 0) : 0
    output += table[byte1 >> 2]
    output += table[((byte1 & 0x03) << 4) | (byte2 >> 4)]
    output += hasByte2 ? table[((byte2 & 0x0f) << 2) | (byte3 >> 6)] : '='
    output += hasByte3 ? table[byte3 & 0x3f] : '='
  }
  return output
}

/** Blob → base64（无 data: 前缀） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  return bytesToBase64(new Uint8Array(buffer))
}

/** 本地日期后缀 YYYY-MM-DD */
export function dateSuffix(now: number = Date.now()): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 带日期的导出文件名：`base-YYYY-MM-DD.ext`（先安全化 base） */
export function datedFileName(base: string, extension: string, now?: number): string {
  const cleanBase = safeFilename(base)
  const cleanExt = extension.replace(/^\.+/, '')
  return `${cleanBase}-${dateSuffix(now)}.${cleanExt}`
}

/** 把 APK 返回的绝对路径转成用户可读路径：`/sdcard/Download/…` → `下载/…` */
export function displayNativePath(path: string, fileName?: string): string {
  const normalized = path.replace(/\\/g, '/')
  const downloadIndex = normalized.indexOf('/Download/')
  if (downloadIndex >= 0) {
    return `下载/${normalized.slice(downloadIndex + '/Download/'.length)}`
  }
  if (normalized.startsWith('/sdcard/')) return normalized.slice('/sdcard/'.length)
  if (normalized) return normalized
  return fileName ? `${EXPORT_FOLDER_LABEL}/${fileName}` : EXPORT_FOLDER_LABEL
}

/** 浏览器下载（旧逻辑，保持向后兼容） */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 统一保存（APK 桥接 / 浏览器下载）。
 * UI 根据 `mode` 给 toast：
 * - native → `已保存到 ${displayNativePath(path, fileName)}`
 * - browser → `已开始下载：${fileName}`
 * - error → `保存失败：${error}`
 */
export async function saveBlobFile(
  blob: Blob,
  fileName: string,
  mime: string,
): Promise<SaveFileResult> {
  const bridge = getBridge()
  if (isNativeApk() && bridge?.saveBase64File) {
    try {
      const base64 = await blobToBase64(blob)
      const result = bridge.saveBase64File(fileName, mime, base64)
      if (typeof result === 'string' && result.startsWith('ok:')) {
        return { mode: 'native', fileName, path: result.slice(3) }
      }
      const reason =
        typeof result === 'string' && result.startsWith('err:')
          ? result.slice(4)
          : '原生保存返回未知结果'
      return { mode: 'error', fileName, error: reason || '保存失败' }
    } catch (error) {
      // 旧版 APK 没有该方法 / 注入异常：退回浏览器下载，不阻塞用户
      downloadBlob(blob, fileName)
      return { mode: 'browser', fileName, error: undefined }
    }
  }
  downloadBlob(blob, fileName)
  return { mode: 'browser', fileName }
}

/** 把保存结果转成 toast 文案（APK/浏览器统一） */
export function saveResultMessage(result: SaveFileResult): { ok: boolean; message: string } {
  if (result.mode === 'native') {
    return {
      ok: true,
      message: `已保存到 ${displayNativePath(result.path ?? '', result.fileName)}`,
    }
  }
  if (result.mode === 'browser') {
    return { ok: true, message: `已开始下载：${result.fileName}` }
  }
  return { ok: false, message: `保存失败：${result.error ?? '未知错误'}` }
}

/** 文本保存（JSON/CSV 导出；mime 默认 application/json） */
export function saveTextFile(
  text: string,
  fileName: string,
  mime = 'application/json',
): Promise<SaveFileResult> {
  return saveBlobFile(new Blob([text], { type: mime }), fileName, mime)
}

/** 文件名安全化（去掉路径/非法字符） */
export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'export'
}

/**
 * 统一导入：弹出标准 `<input type="file">` 选择文件。
 * - APK WebView 由 arch 的 onShowFileChooser 接管；
 * - 不支持的浏览器/无 DOM 环境返回 null（UI toast 提示）。
 */
/** 多文件选择（内容包 .pack.json 多选；无 document 时返回空） */
export function pickTextFiles(
  accept = '.pack.json,application/json',
  multiple = true,
): Promise<File[]> {
  if (typeof document === 'undefined') return Promise.resolve([])
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(files)
    }
    const onFocus = () => window.setTimeout(() => finish(Array.from(input.files ?? [])), 500)
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}

export function pickTextFile(accept = '.json,application/json'): Promise<File | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(file)
    }
    const onFocus = () => {
      // 用户取消选择时 change 不触发；窗口回到前台后兜底
      window.setTimeout(() => finish(input.files?.[0] ?? null), 300)
    }
    input.addEventListener('change', () => finish(input.files?.[0] ?? null))
    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}

/** 读取 `<input type="file">` 的文本内容 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 简单时间格式化：今天/昨天/日期（列表用） */
export function formatRecentTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return '今天'
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return '昨天'
  }
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
