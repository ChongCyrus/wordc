import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node（仅测试读源码）
import { readFileSync } from 'node:fs'

describe('task-117：APK AiApi 原生桥回调回归', () => {
  const src = readFileSync('tools/apk/src/com/dsh/momoreword/MainActivity.java', 'utf8') as string
  it('AiApi 成功/失败回调必须调用 __aiApiCallback（不能误用 __momoApiCallback）', () => {
    const start = src.indexOf('private class AiApiBridge')
    const aiSection = src.slice(start, src.indexOf('// 墨墨 API 原生直连桥', start))
    expect(aiSection).toContain('postAiResult(')
    expect(aiSection).not.toMatch(/(?<!postAiResult)\bpostResult\(/)
    expect(src).toContain('window.__aiApiCallback(')
    expect(src).toContain('postAiResult')
  })
  it('默认 allowlist 包含 api.deepseek.com；仅 https/443/POST；超时 60s', () => {
    expect(src).toContain('AI_DEFAULT_HOST = "api.deepseek.com"')
    expect(src).toContain('AI_TIMEOUT_MS = 60000')
    expect(src).toContain('setConnectTimeout(AI_TIMEOUT_MS)')
    expect(src).toContain('setReadTimeout(AI_TIMEOUT_MS)')
    expect(src).toContain('"POST".equals(verb)')
    expect(src).toContain('"https".equalsIgnoreCase')
  })
})
