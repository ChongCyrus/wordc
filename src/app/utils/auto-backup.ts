/**
 * 自动备份（task-253/254）：APK 原生桥封装；Web/PWA 降级为不可用（不静默下载文件）。
 *
 * 原生协议（window.MomoBridge，WebView JavaBridge 同步调用）：
 * - saveAutoBackup(fileName, base64): 'ok:<path>' | 'err:<reason>'
 * - listAutoBackups(): JSON 字符串 [{name,size,mtime,path}] | 'err:<reason>'
 * - readAutoBackup(fileName): 文本（迁移 JSON）| 'err:<reason>'
 * - deleteAutoBackup(fileName): 'ok' | 'err:<reason>'
 * - pruneAutoBackups(keep): 'ok:<deleted>' | 'err:<reason>'
 * - getFlag(key) / setFlag(key,value): string / 'ok'|'err'
 * - getWebViewStorageInfo(): JSON 字符串 | 'err:<reason>'
 * - appendDiagLog(text): 'ok:<path>' | 'err:<reason>'
 * - selfTestAutoBackup(): JSON 自测结果 | 'err:<reason>'
 */

export interface AutoBackupEntry {
  name: string
  size: number
  /** 毫秒时间戳 */
  mtime: number
  path: string
}

export interface NativeStorageInfo {
  dataDir?: string
  webviewExists?: boolean
  indexedDbExists?: boolean
  indexedDbEntries?: Array<{ name: string; isDir: boolean; size: number; mtime: number }>
}

function gzipName(fileName: string): string {
  return fileName.endsWith('.json.gz')
    ? fileName
    : fileName.endsWith('.json')
      ? fileName.slice(0, -5) + '.json.gz'
      : fileName + '.json.gz'
}

export interface AutoBackupResult {
  ok: boolean
  /** native=已静默写入；unavailable=非 APK（Web 不静默写） */
  mode: 'native' | 'unavailable'
  name?: string
  path?: string
  error?: string
}

function bridge(): Window['MomoBridge'] | undefined {
  if (typeof window === 'undefined') return undefined
  return window.MomoBridge
}

export function isAutoBackupAvailable(): boolean {
  const b = bridge()
  try {
    return b?.isNativeApp?.() === 'momo-apk' && typeof b?.saveAutoBackup === 'function'
  } catch {
    return false
  }
}

function okBody(result: string): string | null {
  return typeof result === 'string' && result.startsWith('ok:') ? result.slice(3) : null
}

function errBody(result: string): string {
  return typeof result === 'string' && result.startsWith('err:') ? result.slice(4) : '原生桥返回未知结果'
}

/** 静默保存自动备份（UTF-8 文本 → base64 → 原生 auto/）。 */
export async function saveAutoBackup(
  text: string,
  fileName: string,
): Promise<AutoBackupResult> {
  const b = bridge()
  const nativeName = gzipName(fileName)
  if (!isAutoBackupAvailable() || !b?.saveAutoBackup) {
    return { ok: false, mode: 'unavailable', name: nativeName, error: '非 APK 环境不静默备份' }
  }
  try {
    const bytes = new TextEncoder().encode(text)
    const base64 = bytesToBase64(bytes)
    const result = String(b.saveAutoBackup(nativeName, base64))
    const path = okBody(result)
    if (path !== null) return { ok: true, mode: 'native', name: nativeName, path }
    return { ok: false, mode: 'native', name: nativeName, error: errBody(result) }
  } catch (error) {
    return { ok: false, mode: 'native', name: nativeName, error: (error as Error).message }
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  if (typeof raw !== 'string' || raw.startsWith('err:')) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 列出 auto 备份（mtime 倒序由原生返回）。非 APK 返回 []。 */
export function listAutoBackups(): AutoBackupEntry[] {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.listAutoBackups) return []
  try {
    return parseJson<AutoBackupEntry[]>(String(b.listAutoBackups()), [])
  } catch {
    return []
  }
}

/** 读取 auto 备份文本；不可用/失败返回 null。 */
export function readAutoBackup(fileName: string): string | null {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.readAutoBackup) return null
  try {
    const result = String(b.readAutoBackup(fileName))
    if (result.startsWith('err:')) return null
    return result
  } catch {
    return null
  }
}

export function deleteAutoBackup(fileName: string): boolean {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.deleteAutoBackup) return false
  try {
    return String(b.deleteAutoBackup(fileName)).startsWith('ok')
  } catch {
    return false
  }
}

/** 只保留最新 keep 个；返回删除数量。 */
export function pruneAutoBackups(keep = 7): number {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.pruneAutoBackups) return 0
  try {
    const result = String(b.pruneAutoBackups(keep))
    const body = okBody(result)
    if (body === null) return 0
    const count = Number.parseInt(body, 10)
    return Number.isFinite(count) ? count : 0
  } catch {
    return 0
  }
}

export function getAutoBackupFlag(key: string): string {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.getFlag) return ''
  try {
    return String(b.getFlag(key) ?? '')
  } catch {
    return ''
  }
}

export function setAutoBackupFlag(key: string, value: string): boolean {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.setFlag) return false
  try {
    return String(b.setFlag(key, value)).startsWith('ok')
  } catch {
    return false
  }
}

export function getWebViewStorageInfo(): NativeStorageInfo | null {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.getWebViewStorageInfo) return null
  try {
    return parseJson<NativeStorageInfo | null>(String(b.getWebViewStorageInfo()), null)
  } catch {
    return null
  }
}

export function appendDiagLog(text: string): string | null {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.appendDiagLog) return null
  try {
    const result = String(b.appendDiagLog(text))
    return okBody(result)
  } catch {
    return null
  }
}

export function readDiagnosticFile(): string | null {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.readDiagnosticFile) return null
  try {
    const result = String(b.readDiagnosticFile())
    return result.startsWith('err:') ? null : result
  } catch {
    return null
  }
}

/** 把某份内部备份显式导出到 Download（用户主动按钮用）。 */
export function exportBackupToDownloads(fileName: string): { ok: boolean; path?: string; error?: string } {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.exportBackupToDownloads) {
    return { ok: false, error: '当前环境不支持导出' }
  }
  try {
    const result = String(b.exportBackupToDownloads(fileName))
    if (result.startsWith('ok:')) return { ok: true, path: result.slice(3) }
    return { ok: false, error: result.startsWith('err:') ? result.slice(4) : result }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export function selfTestAutoBackup(): Record<string, unknown> | null {
  const b = bridge()
  if (!isAutoBackupAvailable() || !b?.selfTestAutoBackup) return null
  try {
    return parseJson<Record<string, unknown> | null>(String(b.selfTestAutoBackup()), null)
  } catch {
    return null
  }
}

// bytesToBase64 与 files.ts 共用同一实现；此文件避免循环依赖，直接导入纯函数。
import { bytesToBase64 } from './files'
