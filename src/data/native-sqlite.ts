/** 0.11.0 M1：异步 SQLite bridge 客户端（WebView → native requestId/Promise） */
export type SqliteErrorCode =
  | 'E_UNSUPPORTED'
  | 'E_BUSY'
  | 'E_IO'
  | 'E_QUOTA'
  | 'E_SCHEMA'
  | 'E_CONFLICT'
  | 'E_TOO_LARGE'
  | 'E_CORRUPT'
  | 'E_ABORTED'
  | 'E_TIMEOUT'
  | 'E_BAD_RESPONSE'

export class SqliteError extends Error {
  readonly code: SqliteErrorCode
  readonly retryable: boolean
  constructor(code: SqliteErrorCode, message: string) {
    super(message)
    this.name = 'SqliteError'
    this.code = code
    this.retryable = code === 'E_BUSY' || code === 'E_TIMEOUT'
  }
}

export interface SqliteTransport {
  sqliteCall(reqJson: string): string
  sqliteCancel?(requestId: string): string
}

export interface SqliteCallOptions {
  method: 'health' | 'query' | 'exec' | 'tx' | 'backup' | 'restoreDb' | 'integrity' | 'selfTest'
  ops?: unknown[]
  expect?: { userVersion?: number; dataEpoch?: number }
  timeoutMs?: number
  maxBytes?: number
  tx?: boolean
  payload?: Record<string, unknown>
  path?: string
}

export interface SqliteResponse<T = unknown> {
  ok: boolean
  requestId?: string
  code?: SqliteErrorCode
  message?: string
  data?: T
  result?: T
  checks?: unknown
  rows?: unknown[]
  changes?: number
  dataEpoch?: number
  nextCursor?: string | null
  userVersion?: number
  wal?: boolean
  synchronous?: string
  readOnly?: boolean
  integrityOk?: boolean
  sizeBytes?: number
}

type Pending = {
  resolve: (response: SqliteResponse) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let transport: SqliteTransport | null = null
let callbackInstalled = false
let seq = 0

function installCallback(): void {
  if (callbackInstalled) return
  callbackInstalled = true
  const target = globalThis as unknown as {
    __momoSqliteResult?: (requestId: string, json: string) => void
  }
  target.__momoSqliteResult = (requestId: string, json: string) => {
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    if (entry.timer) clearTimeout(entry.timer)
    try {
      const parsed = JSON.parse(json) as SqliteResponse
      if (!parsed || typeof parsed !== 'object') {
        entry.reject(new SqliteError('E_BAD_RESPONSE', 'SQLite 响应不是对象'))
        return
      }
      entry.resolve(parsed)
    } catch (error) {
      entry.reject(new SqliteError('E_BAD_RESPONSE', error instanceof Error ? error.message : String(error)))
    }
  }
}

export function setSqliteTransport(next: SqliteTransport | null): void {
  transport = next
  installCallback()
}

function defaultTransport(): SqliteTransport | null {
  const globals = globalThis as unknown as {
    MomoBridge?: { sqliteCall?: (json: string) => string; sqliteCancel?: (id: string) => string }
    MomoSqlite?: { sqliteCall?: (json: string) => string; sqliteCancel?: (id: string) => string }
  }
  const bridge = globals.MomoBridge?.sqliteCall ? globals.MomoBridge : globals.MomoSqlite
  if (!bridge?.sqliteCall) return null
  return {
    sqliteCall: (json) => bridge.sqliteCall!(json),
    ...(bridge.sqliteCancel ? { sqliteCancel: (id: string) => bridge.sqliteCancel!(id) } : {}),
  }
}

export function isSqliteAvailable(): boolean {
  return Boolean(transport ?? defaultTransport())
}

/** 单次异步调用：native 返回 requestId，结果经 __momoSqliteResult 回传；超时自动 cancel */
function performSqliteCall<T = unknown>(opts: SqliteCallOptions): Promise<SqliteResponse<T>> {
  installCallback()
  const active = transport ?? defaultTransport()
  if (!active) return Promise.reject(new SqliteError('E_UNSUPPORTED', '当前环境不支持原生 SQLite'))
  seq += 1
  const requestId = `sqlite-${Date.now()}-${seq}`
  const request = {
    id: requestId,
    method: opts.method,
    ...(opts.tx ? { tx: true } : {}),
    ...(opts.ops ? { ops: opts.ops } : {}),
    ...(opts.expect ? { expect: opts.expect } : {}),
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.payload ? { payload: opts.payload } : {}),
    ...(opts.path ? { path: opts.path } : {}),
  }
  return new Promise<SqliteResponse<T>>((resolve, reject) => {
    let parsedId: string
    try {
      const result = JSON.parse(active.sqliteCall(JSON.stringify(request))) as {
        requestId?: string
        error?: { code?: SqliteErrorCode; message?: string }
      }
      if (result.error) {
        reject(new SqliteError(result.error.code ?? 'E_BAD_RESPONSE', result.error.message ?? 'native sqliteCall 失败'))
        return
      }
      parsedId = result.requestId ?? requestId
    } catch (error) {
      reject(new SqliteError('E_BAD_RESPONSE', error instanceof Error ? error.message : String(error)))
      return
    }
    const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 15_000))
    const timer = setTimeout(() => {
      if (!pending.has(parsedId)) return
      pending.delete(parsedId)
      try {
        active.sqliteCancel?.(parsedId)
      } catch {
        /* ignore */
      }
      reject(new SqliteError('E_TIMEOUT', `SQLite 调用超时（>${timeoutMs}ms）`))
    }, timeoutMs)
    pending.set(parsedId, {
      resolve: (response) => {
        if (response.ok === false) {
          reject(new SqliteError(response.code ?? 'E_IO', response.message ?? 'SQLite 操作失败'))
        } else {
          resolve(response as SqliteResponse<T>)
        }
      },
      reject,
      timer,
    })
  })
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof SqliteError)) return false
  if (error.code === 'E_BUSY') return true
  // native 可能把 SQLiteDatabaseLockedException 映射成 E_IO；按 message 兜底识别
  return error.code === 'E_IO' && /locked|busy|SQLITE_LOCKED|SQLITE_BUSY/i.test(error.message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let callChain: Promise<unknown> = Promise.resolve()

/** 0.11.0 M4b-0：所有 SQLite 调用严格串行；E_BUSY/locked 指数退避重试，不冒泡成页面错误 */
export function sqliteCall<T = unknown>(opts: SqliteCallOptions): Promise<SqliteResponse<T>> {
  const run = callChain.then(
    async (): Promise<SqliteResponse<T>> => {
      let lastError: unknown
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await performSqliteCall<T>(opts)
        } catch (error) {
          lastError = error
          if (!isBusyError(error) || attempt >= 3) throw error
          await sleep(100 * 2 ** attempt)
        }
      }
      throw lastError
    },
    async (): Promise<SqliteResponse<T>> => performSqliteCall<T>(opts),
  )
  callChain = run.then(() => undefined, () => undefined)
  return run
}

export function sqliteHealth(timeoutMs = 5_000): Promise<SqliteResponse> {
  return sqliteCall({ method: 'health', timeoutMs })
}

export function sqliteExec(ops: unknown[], opts: Omit<SqliteCallOptions, 'method' | 'ops'> = {}): Promise<SqliteResponse> {
  return sqliteCall({ method: 'exec', ops, ...opts })
}

export function sqliteTx(ops: unknown[], opts: Omit<SqliteCallOptions, 'method' | 'ops'> = {}): Promise<SqliteResponse> {
  return sqliteCall({ method: 'tx', tx: true, ops, ...opts })
}

export function sqliteQuery<T = unknown>(
  query: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<SqliteResponse<T>> {
  return sqliteCall<T>({ method: 'query', payload: query, timeoutMs })
}

export function sqliteBackup(timeoutMs = 60_000): Promise<SqliteResponse> {
  return sqliteCall({ method: 'backup', timeoutMs })
}

export function sqliteIntegrity(timeoutMs = 30_000): Promise<SqliteResponse> {
  return sqliteCall({ method: 'integrity', timeoutMs })
}

/** M5：恢复 SQLite .db 备份（native 校验 integrity/userVersion、备份旧库、失败回滚） */
export function sqliteRestoreDb(path: string, timeoutMs = 60_000): Promise<SqliteResponse> {
  return sqliteCall({ method: 'restoreDb', path, timeoutMs })
}
