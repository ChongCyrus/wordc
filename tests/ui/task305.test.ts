import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const settings = src('ui/me/SettingsPage.tsx')
const decks = src('ui/decks/DecksPage.tsx')
const service = src('app/utils/auto-backup-service.ts')

describe('task-305 0.10.0 破坏性操作预备份', () => {
  it('clearAllData/deleteDeck/importDeckFile 均传 preBackup', () => {
    expect(settings).toContain('createFactsPreBackup')
    expect(settings).toContain('preBackup:')
    expect(decks).toContain('preBackup: createPreBackup')
    expect(decks).toContain("导入词库会覆盖同名词库并清空该词库学习进度")
    expect(service).toContain('export async function createPreBackup')
    expect(service).toContain("return { ok: false, error: '当前环境无法自动备份")
  })
})
