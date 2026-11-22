import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const css = src('app/styles/global.css')

describe('task-283 大备份恢复持久状态', () => {
  it('弹窗内进度/耗时/结果/错误，不依赖 toast', () => {
    expect(me).toContain('autoRestoreStatus')
    expect(me).toContain('正在从备份恢复')
    expect(me).toContain('已等待')
    expect(me).toContain('请勿离开页面或切到后台')
    expect(me).toContain('恢复完成')
    expect(me).toContain('恢复失败，错误信息已保留')
    expect(me).toContain('auto-restore-error')
    expect(me).toContain('恢复前已自动备份')
    expect(css).toContain('.auto-restore-progress')
    expect(css).toContain('.auto-restore-error')
    expect(me).toContain('getAutoBackupRestoreStatus')
    expect(me).toContain('最近恢复')
    expect(me).toContain('恢复中：')
    expect(me).toContain('读取备份')
    expect(me).toContain('恢复被中断')
  })
})
