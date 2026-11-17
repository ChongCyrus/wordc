import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node（仅测试读源码）
import { readFileSync } from 'node:fs'

describe('task-117：APK AiApi 原生桥回调回归', () => {
  const src = readFileSync('tools/apk/src/com/dsh/momoreword/MainActivity.java', 'utf8') as string
  it('AiApi 成功/失败回调必须调用 __aiApiCallback（不能误用 __momoApiCallback）', () => {
    const start = src.indexOf('private class AiApiBridge')
    expect(start).toBeGreaterThanOrEqual(0)
    // 不依赖注释标记（公开树 sanitize 可能去掉注释）：截到下一个 private class 或文件尾
    const rest = src.slice(start + 1)
    const nextClass = rest.search(/private\s+class\s+(?!AiApiBridge)\w+/)
    const end = nextClass >= 0 ? start + 1 + nextClass : src.length
    const aiSection = src.slice(start, end)
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
