/**
 * APK 桥接 / 文件导出导入（task-32）单元测试。
 * 在 node 环境 mock window.MomoBridge / document / URL，断言两条分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blobToBase64,
  bytesToBase64,
  datedFileName,
  displayNativePath,
  isNativeApk,
  saveBlobFile,
  saveResultMessage,
} from '../../src/app/utils/files'

interface BridgeCall {
  fileName: string
  mime: string
  base64: string
}

const globals = globalThis as unknown as {
  window?: unknown
  document?: unknown
  URL?: unknown
}

let bridgeCall: BridgeCall | null = null
let anchorDownload: string | null = null
let anchorClickCount = 0

function installWindow(bridge?: {
  isNativeApp?: () => string
  saveBase64File?: (fileName: string, mime: string, base64: string) => string
}) {
  globals.window = { MomoBridge: bridge, setTimeout: globalThis.setTimeout } as unknown
}

function installBrowserGlobals() {
  anchorDownload = null
  anchorClickCount = 0
  globals.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => undefined }
  globals.document = {
    body: { appendChild: () => undefined },
    createElement: () => ({
      href: '',
      download: '',
      rel: '',
      click() {
        anchorClickCount += 1
        anchorDownload = this.download as string
      },
      remove: () => undefined,
    }),
  }
}

beforeEach(() => {
  bridgeCall = null
  installWindow()
  installBrowserGlobals()
})

afterEach(() => {
  delete globals.window
  delete globals.document
  delete globals.URL
  vi.restoreAllMocks()
})

const CONTENT = '{"format":"momo-migration","name":"中文备份"}'
/** 用 `printf '%s' "${CONTENT}" | base64 -w0` 算出的标准 base64（无 data: 前缀） */
const CONTENT_BASE64 =
  'eyJmb3JtYXQiOiJtb21vLW1pZ3JhdGlvbiIsIm5hbWUiOiLkuK3mloflpIfku70ifQ=='
const MIME = 'application/json'

describe('base64 编码', () => {
  it('UTF-8 中文内容与标准 base64 一致（无 data: 前缀）', async () => {
    const bytes = new TextEncoder().encode(CONTENT)
    expect(bytesToBase64(bytes)).toBe(CONTENT_BASE64)
    expect(await blobToBase64(new Blob([CONTENT], { type: MIME }))).toBe(CONTENT_BASE64)
  })
})

describe('APK 分支（window.MomoBridge= momo-apk）', () => {
  it('调用 saveBase64File（纯 base64/同步 string），不触发 blob 下载', async () => {
    installWindow({
      isNativeApp: () => 'momo-apk',
      saveBase64File: (fileName, mime, base64) => {
        bridgeCall = { fileName, mime, base64 }
        return 'ok:/storage/emulated/0/Download/WordC/备份-2026-11-11.json'
      },
    })
    expect(isNativeApk()).toBe(true)

    const result = await saveBlobFile(
      new Blob([CONTENT], { type: MIME }),
      '备份-2026-11-11.json',
      MIME,
    )
    expect(result.mode).toBe('native')
    expect(result.path).toContain('/Download/WordC/')
    expect(bridgeCall).not.toBeNull()
    expect(bridgeCall?.fileName).toBe('备份-2026-11-11.json')
    expect(bridgeCall?.mime).toBe(MIME)
    expect(bridgeCall?.base64).toBe(CONTENT_BASE64)
    expect(bridgeCall?.base64.startsWith('data:')).toBe(false)
    // 不触发 <a download>
    expect(anchorClickCount).toBe(0)
  })

  it('err:<原因> → 返回 error（如 Android 9 存储权限），提示透传', async () => {
    installWindow({
      isNativeApp: () => 'momo-apk',
      saveBase64File: () => 'err:需要存储权限，请在系统弹窗中允许后重试',
    })
    const result = await saveBlobFile(new Blob([CONTENT]), '备份.json', MIME)
    expect(result.mode).toBe('error')
    expect(result.error).toContain('需要存储权限')
    const info = saveResultMessage(result)
    expect(info.ok).toBe(false)
    expect(info.message).toContain('需要存储权限')
    expect(anchorClickCount).toBe(0)
  })

  it('中文文件名与路径展示：下载/WordC/…', async () => {
    const result = await saveBlobFile(new Blob(['{}']), '学习进度-2026-11-11.json', MIME)
    expect(result.mode).toBe('browser')
    expect(
      displayNativePath(
        '/storage/emulated/0/Download/WordC/学习进度-2026-11-11.json',
      ),
    ).toBe('下载/WordC/学习进度-2026-11-11.json')
    expect(displayNativePath('/sdcard/Download/WordC/a.json')).toBe(
      '下载/WordC/a.json',
    )
    const nativeInfo = saveResultMessage({
      mode: 'native',
      fileName: 'a.json',
      path: '/storage/emulated/0/Download/WordC/a.json',
    })
    expect(nativeInfo.message).toBe('已保存到 下载/WordC/a.json')
  })
})

describe('非 APK 分支（浏览器/PWA）', () => {
  it('保持 blob + <a download>，不调用桥接', async () => {
    installWindow(undefined)
    expect(isNativeApk()).toBe(false)

    const result = await saveBlobFile(
      new Blob([CONTENT], { type: MIME }),
      '备份-2026-11-11.json',
      MIME,
    )
    expect(result.mode).toBe('browser')
    expect(anchorClickCount).toBe(1)
    expect(anchorDownload).toBe('备份-2026-11-11.json')
    expect(bridgeCall).toBeNull()
    expect(saveResultMessage(result).message).toContain('已开始下载')
  })
})

describe('导出文件名（带日期，APK/Web 一致）', () => {
  it('datedFileName 带 YYYY-MM-DD 且保留中文', () => {
    const fixed = new Date(2026, 10, 11, 23, 30).getTime()
    expect(datedFileName('背单词-学习进度', 'migration.json', fixed)).toBe(
      '背单词-学习进度-2026-11-11.migration.json',
    )
    expect(datedFileName('考研受限商业词表', '.deck.json', fixed)).toBe(
      '考研受限商业词表-2026-11-11.deck.json',
    )
    expect(datedFileName('a/b:c', 'json', fixed)).toBe('a_b_c-2026-11-11.json')
  })
})
