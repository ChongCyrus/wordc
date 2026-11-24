import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const settings = src('ui/me/SettingsPage.tsx')
const me = src('ui/me/MePage.tsx')

describe('task-325 导入 guard 已移除、sqlite 走 staging', () => {
  it('两页导入入口恢复可点，不再存在 sqlite 禁用文案', () => {
    for (const page of [settings, me]) {
      expect(page).toContain('导入学习进度')
      expect(page).toContain('preBackup: async () =>')
      expect(page).not.toContain('0.11 暂不支持导入旧 JSON')
    }
  })

  it('成功显示 counts、失败真实报告，不假成功', () => {
    expect(me).toContain('导入完成：${report.counts.decks} 词库 / ${report.counts.words} 词 / ${report.counts.states} 条状态')
    expect(me).toContain('导入失败：${issue.message}')
    expect(settings).toContain('describeReport(report)')
    expect(settings).toContain("toast.error(describeReport(report))")
  })
})
