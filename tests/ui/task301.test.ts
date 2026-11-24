import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)
const hook = readFileSync(
  fileURLToPath(new URL('../../src/app/hooks/useGeneratedSeedStatus.ts', import.meta.url)),
  'utf8',
)

describe('task-301 0.7.0 预装词根缀源状态', () => {
  it('显示导入数量/总数/版本/进度/失败', () => {
    expect(me).toContain('rootEtymologyImported')
    expect(me).toContain('rootEtymologyTotal')
    expect(me).toContain('rootEtymologyVersion')
    expect(me).toContain('rootEtymologyState')
    expect(me).toContain('rootEtymologyError')
    expect(me).toContain('词根缀源导入中')
    expect(me).toContain('词根缀源失败')
    expect(me).toContain('v${version}')
    expect(me).toContain('词根缀源状态读取中')
    expect(hook).toContain('momo:generated-seed-updated')
    expect(hook).toContain('visibilitychange')
    expect(hook).toContain('focus')
    expect(hook).toContain('window.setInterval(() => void refresh(), pollMs)')
    expect(hook).toContain('window.clearInterval(timer)')
  })
})
