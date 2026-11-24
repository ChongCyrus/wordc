import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const service = src('app/utils/auto-backup-service.ts')

describe('task-315 启动计时进诊断', () => {
  it('诊断包/SQLite 自检带 startupTiming', () => {
    expect(me).toContain('startup: getStartupTiming()')
    expect(service).toContain('getStartupTiming')
    expect(service).toContain('serialized.startupTiming')
    expect(src('app/layout/AppShell.tsx')).toContain('markStartupPhase')
  })
})
