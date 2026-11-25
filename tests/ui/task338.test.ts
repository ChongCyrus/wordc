import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const dbg = src('ui/me/DebugPage.tsx')
const home = src('ui/home/HomePage.tsx')
const card = src('ui/home/HomeTaskCard.tsx')

describe('task-338 0.15 UI 收敛', () => {
  it('移除切源/完成自检/回退按钮，只读 source/migration', () => {
    expect(dbg).not.toContain('切换到 SQLite 内容写')
    expect(dbg).not.toContain('完成覆盖自检')
    expect(dbg).not.toContain('回退内容写源到 IDB')
    expect(dbg).toContain('v15 单一事实源迁移')
    expect(dbg).toContain('contentState?.source')
    expect(dbg).toContain('重建内容缓存')
    expect(dbg).toContain('清理过期内容库')
  })

  it('首页添加按钮未 ready（迁移 running）禁用+加载态', () => {
    expect(home).toContain('getContentMigrationState')
    expect(home).toContain("state?.status === 'running'")
    expect(home).toContain('addWordsDisabled={contentMigrationRunning}')
    expect(home).toContain('内容迁移中…')
    expect(card).toContain('addWordsDisabled')
    expect(card).toContain('addWordsLoading')
  })
})
