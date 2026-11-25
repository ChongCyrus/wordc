import { describe, expect, it } from 'vitest'
import {
  CONTENT_DOWNGRADE_MESSAGE,
  isContentDowngradeError,
  mapContentError,
} from '../../src/app/utils/content-errors'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-337 E_DOWNGRADE 统一 UX', () => {
  it('结构化 code/message 映射为版本提示，不显示空库', () => {
    expect(CONTENT_DOWNGRADE_MESSAGE).toContain('版本不支持该内容备份')
    expect(CONTENT_DOWNGRADE_MESSAGE).toContain('不要清空数据库')
    expect(isContentDowngradeError(Object.assign(new Error('x'), { code: 'E_DOWNGRADE' }))).toBe(true)
    expect(isContentDowngradeError(new Error('SQLite schema v3 高于当前 App 支持 v2（E_DOWNGRADE）'))).toBe(true)
    expect(mapContentError(new Error('E_DOWNGRADE'))).toBe(CONTENT_DOWNGRADE_MESSAGE)
    expect(mapContentError(new Error('其它错误'))).toBe('其它错误')
  })

  it('DebugPage/恢复/启动均使用统一映射', () => {
    expect(src('ui/me/DebugPage.tsx')).toContain('mapContentError')
    expect(src('ui/me/ContentBackupSection.tsx')).toContain('mapContentError')
    expect(src('ui/me/ImportExportPage.tsx')).toContain('mapContentError')
    expect(src('app/layout/AppShell.tsx')).toContain('CONTENT_DOWNGRADE_MESSAGE')
  })
})
