import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const settings = src('ui/me/SettingsPage.tsx')
const me = src('ui/me/MePage.tsx')
const decks = src('ui/decks/DecksPage.tsx')

describe('task-322 A3 sqlite 导入 fail-closed', () => {
  it('importMigration 必带 preBackup；importDeckFile sqlite 模式禁用提示', () => {
    expect(settings).toContain("strategy: 'merge'")
    expect(settings).toContain('createFactsPreBackup')
    expect(me).toContain("strategy: 'merge'")
    expect(me).toContain('createFactsPreBackup')
    expect(decks).toContain('getLearningWriteSource')
    expect(decks).toContain('sqliteLearningMode')
    expect(decks).toContain("'该功能暂时不可用，请更新/恢复'")
    expect(decks).toContain('disabled={sqliteLearningMode}')
  })
})
