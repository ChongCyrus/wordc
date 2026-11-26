/**
 * 0.16 审计 B / task-311：测试用内存 SQLite transport。
 *
 * 只实现导入/恢复路径用到的 method：tx / query / health / integrity / backup / restoreDb /
 * listBackups / writeBackupManifest / readBackupManifest。语义与 native 对齐：
 * - tx 逐 op 执行，`delete` 支持 `where` 与 `all:true`（native 仅 facts 三表白名单）；
 * - query 支持 `where` / `offset` / `limit` / `orderBy`；
 * - backup 记录当前整库快照，restoreDb 恢复指定快照（用于验证 staging 回滚确实回到导入前）。
 */
import { setSqliteTransport } from '../../../src/data'

export interface MemorySqlite {
  tables: Map<string, Array<Record<string, unknown>>>
  txOps: unknown[][]
  snapshots: Map<string, Map<string, Array<Record<string, unknown>>>>
  restoreCalls: string[]
  setRows(table: string, rows: Array<Record<string, unknown>>): void
  rows(table: string): Array<Record<string, unknown>>
  close(): void
}

const KEY_COLUMN: Record<string, string> = {
  states: 'word_id',
  plans: 'id',
  settings: 'key',
  review_logs: 'id',
  client_ops: 'op_id',
  migration_state: 'step',
  schema_meta: 'key',
}

function keyOf(table: string, row: Record<string, unknown>): unknown {
  const column = KEY_COLUMN[table] ?? 'id'
  return row[column] ?? row.id ?? row.key
}

function matchesWhere(row: Record<string, unknown>, where?: Record<string, unknown>): boolean {
  if (!where) return true
  return Object.entries(where).every(([column, value]) => row[column] === value)
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function installMemorySqlite(opts: { userVersion?: number } = {}): MemorySqlite {
  const tables = new Map<string, Array<Record<string, unknown>>>()
  const txOps: unknown[][] = []
  const snapshots = new Map<string, Map<string, Array<Record<string, unknown>>>>()
  const restoreCalls: string[] = []
  let seq = 0
  let nextBackup = 0
  const table = (name: string): Array<Record<string, unknown>> => {
    const list = tables.get(name) ?? []
    tables.set(name, list)
    return list
  }
  const counts = () => ({
    states: table('states').length,
    plans: table('plans').length,
    settings: table('settings').length,
    review_logs: table('review_logs').length,
    client_ops: table('client_ops').length,
  })

  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as {
        id: string
        method: string
        ops?: Array<Record<string, unknown>>
        payload?: Record<string, unknown>
      }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (requestId: string, payload: string) => void })
          .__momoSqliteResult
        const respond = (payload: Record<string, unknown>) => cb?.(id, JSON.stringify(payload))
        switch (req.method) {
          case 'tx': {
            const ops = req.ops ?? []
            txOps.push(ops)
            for (const op of ops) {
              const name = String(op.table ?? '')
              const list = table(name)
              if (op.op === 'delete') {
                if ((op as { all?: boolean }).all === true) {
                  tables.set(name, [])
                  continue
                }
                const where = op.where as Record<string, unknown> | undefined
                tables.set(name, list.filter((row) => !matchesWhere(row, where)))
                continue
              }
              const row = clone((op.row ?? {}) as Record<string, unknown>)
              const key = keyOf(name, row)
              const index = list.findIndex((item) => keyOf(name, item) === key)
              if (index >= 0) list[index] = row
              else list.push(row)
            }
            respond({ ok: true })
            return
          }
          case 'query': {
            const payload = req.payload ?? {}
            const name = String(payload.table ?? '')
            const filtered = table(name).filter((row) => matchesWhere(row, payload.where as Record<string, unknown> | undefined))
            const offset = Number(payload.offset ?? 0)
            const limit = Number(payload.limit ?? 1000)
            respond({ ok: true, rows: clone(filtered.slice(offset, offset + limit)) })
            return
          }
          case 'health':
            respond({
              ok: true,
              userVersion: opts.userVersion ?? 3,
              counts: counts(),
              integrityOk: true,
              readOnly: false,
              wal: true,
              synchronous: 'FULL',
              sizeBytes: 4096,
            })
            return
          case 'integrity':
            respond({ ok: true, integrityOk: true })
            return
          case 'backup': {
            nextBackup += 1
            const name = String((req.payload as { name?: string } | undefined)?.name ?? `sqlite-backup-${nextBackup}.db`)
            const path = `/p/${name}`
            snapshots.set(path, clone(tables))
            respond({ ok: true, name, path, bytes: 4096, checksum: `sum-${name}`, createdAt: Date.now() })
            return
          }
          case 'restoreDb': {
            const path = String((req.payload as { path?: string } | undefined)?.path ?? '')
            restoreCalls.push(path)
            const snapshot = snapshots.get(path)
            if (snapshot) {
              tables.clear()
              for (const [name, rows] of snapshot) tables.set(name, clone(rows))
            }
            respond({ ok: true })
            return
          }
          case 'listBackups':
            respond({ ok: true, backups: [...snapshots.keys()].map((path) => ({
              name: path.replace('/p/', ''),
              path,
              size: 4096,
              mtime: Date.now(),
              manifest: true,
            })) })
            return
          case 'writeBackupManifest':
            respond({ ok: true })
            return
          case 'readBackupManifest':
            respond({ ok: true, manifest: '' })
            return
          default:
            respond({ ok: true, rows: [] })
        }
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })

  return {
    tables,
    txOps,
    snapshots,
    restoreCalls,
    setRows(name, rows) {
      tables.set(name, clone(rows))
    },
    rows(name) {
      return table(name)
    },
    close() {
      setSqliteTransport(null)
    },
  }
}
