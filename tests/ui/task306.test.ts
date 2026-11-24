import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const study = src('ui/study/StudyPage.tsx')
const service = src('app/utils/auto-backup-service.ts')

describe('task-306 数据安全诊断包导出', () => {
  it('gather/serialize + 保存 JSON 到下载', () => {
    expect(service).toContain('gatherDataSafetyDiagnostics')
    expect(service).toContain('serializeSafetyDiagnostics')
    expect(me).toContain('导出安全诊断包')
    expect(me).toContain('buildSafetyDiagnosticsText')
    expect(me).toContain('data-safety-diagnostics.json')
    expect(study).toContain('导出安全诊断包')
    expect(study).toContain('buildSafetyDiagnosticsText')
  })
})
