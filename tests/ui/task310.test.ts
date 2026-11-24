import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-310 M3 dryRun UI', () => {
  it('只演练 migrateIdbToSqlite dryRun，显示 IDB/SQLite counts/批次/错误，导出下载', () => {
    expect(me).toContain('SQLite M3 迁移演练（dryRun）')
    expect(me).toContain('migrateIdbToSqlite({ dryRun: true, batchSize: 200 })')
    expect(me).toContain('idbCounts')
    expect(me).toContain('sqliteHealth')
    expect(me).toContain('batches')
    expect(me).toContain('sqlite-m3-dryrun.json')
    expect(me).not.toContain('SQLite M3 执行迁移')
  })
})
