import '../test-utils'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- 项目 tsconfig 只含 vite/client，测试里用 Node 内置模块（运行时可用）
import { existsSync, readFileSync } from 'node:fs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- 同上
import { join } from 'node:path'

declare const process: { cwd(): string; env: Record<string, string | undefined> }

import { beforeEach, describe, expect, it } from 'vitest'

import {
  ensureBuiltinDecks,
  getDb,
  importMaimemoProgress,
  importMaimemoRecords,
  parseMaimemoRecordsJson,
  probeMaimemoToken,
  resetDatabase,
  setMaimemoSession,
} from '../../../src/data'

/**
 * 真实墨墨数据验收（D44/D46）。
 *
 * ⚠️ 隐私红线：本文件**不包含任何 Token 或用户数据**：
 * - 数据来自 Lead 缓存的 `.secrets/user-export/records-all.json`（gitignore，绝不入库）；
 * - Token 从 `.secrets/maimemo-token` 运行时读取（gitignore，不打印、不写日志）；
 * - 缓存/Token 不存在时整组测试自动 skip，普通开发/CI 只跑 mock 测试。
 *
 * 手工跑真实 Token 连通性验收（只发 1 个轻量请求，不重新全量抓）：
 *   MAIMEMO_LIVE=1 pnpm exec vitest run tests/data/api/maimemo-real-data.test.ts
 */

const ROOT = process.cwd()
const CACHE_PATH = join(ROOT, '.secrets/user-export/records-all.json')
const TOKEN_PATH = join(ROOT, '.secrets/maimemo-token')
const HAS_CACHE = existsSync(CACHE_PATH)
const HAS_TOKEN = existsSync(TOKEN_PATH)

beforeEach(async () => {
  await resetDatabase()
})

describe.skipIf(!HAS_CACHE)('真实墨墨缓存（796 条记录 → 735 匹配 / 61 未匹配，D46）', () => {
  it('导入结果与 Lead 实测口径一致，且不造词、不改内置词表', async () => {
    await ensureBuiltinDecks()
    const db = getDb()
    const wordsBefore = await db.words.count()

    const text = readFileSync(CACHE_PATH, 'utf8')
    const records = parseMaimemoRecordsJson(text)
    expect(records.length).toBe(796)

    // 真实数据 last_response 分布（D46）
    const responseCounts = new Map<string, number>()
    for (const record of records) {
      const raw = String((record as { last_response?: string }).last_response ?? 'UNSPECIFIED')
      responseCounts.set(raw, (responseCounts.get(raw) ?? 0) + 1)
    }
    expect(responseCounts.get('FAMILIAR')).toBe(565)
    expect(responseCounts.get('VAGUE')).toBe(63)
    expect(responseCounts.get('FORGET')).toBe(103)
    expect(responseCounts.get('STUDY_RESPONSE_UNSPECIFIED')).toBe(65)

    const result = await importMaimemoRecords(records)
    expect(result.ok).toBe(true)
    expect(result.totalRecords).toBe(796)
    // 受限商业词表（默认词库）匹配数：735；两库都没有的 61 个进 unmatched（D43/D46）
    expect(result.matched).toBe(735)
    expect(result.unmatchedCount).toBe(61)
    expect(result.matched + result.unmatchedCount + result.skipped).toBe(796)

    // 只写 states；词表条数不变；state 数 = 匹配数
    expect(await db.words.count()).toBe(wordsBefore)
    expect(await db.states.count()).toBe(735)

    // 抽查：到期日按 next_study_date 落本地日期 00:00
    const states = await db.states.toArray()
    expect(states.every((state) => state.importedFrom === 'maimemo')).toBe(true)
    expect(states.filter((state) => state.dueAt != null && state.dueAt <= Date.now()).length).toBeGreaterThan(0)
    // 不熟悉度初始 0.5（D24）
    const withStats = states.find((state) => Object.keys(state.meaningStats).length > 0)!
    const stat = Object.values(withStats.meaningStats)[0]!
    expect(stat.clicks / stat.encounters).toBe(0.5)
  }, 180_000)
})

describe.skipIf(!HAS_TOKEN || process.env.MAIMEMO_LIVE_NET !== '1')(
  'task-40：真实 Token 端到端「按拼写批量」拉取 + 导入（本机 Node）',
  () => {
    it('spellings 策略：请求数 ≤80、无 429、记录量与官方数据同量级', async () => {
      const token = readFileSync(TOKEN_PATH, 'utf8').trim()
      expect(token.length).toBeGreaterThan(10)
      await ensureBuiltinDecks()
      const startedAt = Date.now()
      const result = await importMaimemoProgress({
        token,
        proxyUrl: '',
        batchSize: 500,
        minIntervalMs: 3_200,
      })
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(
        `[live-net] strategy=${result.strategy} pages=${result.pages} scanned=${result.scanned} ` +
          `records=${result.totalRecords} matched=${result.matched} unmatched=${result.unmatchedCount} skipped=${result.skipped} 用时=${seconds}s`,
      )
      expect(result.pages).toBeGreaterThan(0)
      expect(result.pages).toBeLessThanOrEqual(80) // 任务硬上限
      expect(result.strategy).toBe('spellings')
      expect(result.scanned).toBeGreaterThan(6000) // 本地词库拼写规模
      expect(result.totalRecords).toBeGreaterThan(700) // 与记录快照（796）/当前 983 同量级
      expect(result.ok).toBe(true)
      expect(result.skipped).toBe(0)
      // 状态确实写入（幂等覆盖）
      expect(await getDb().states.count()).toBe(result.matched)
    }, 300_000)
  },
)

describe.skipIf(!HAS_CACHE || !HAS_TOKEN || process.env.MAIMEMO_LIVE !== '1')(
  '真实 Token 连通性（只发 1 个轻量请求）',
  () => {
    it('全量拉取 + 导入：请求次数、796 条、735 匹配 / 61 跳过（D45/D46 验收）', async () => {
      const token = readFileSync(TOKEN_PATH, 'utf8').trim()
      expect(token.length).toBeGreaterThan(10)
      await ensureBuiltinDecks()
      const startedAt = Date.now()
      const result = await importMaimemoProgress({ token, proxyUrl: '' })
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(
        `[live] 全量拉取+导入：pages=${result.pages} totalRecords=${result.totalRecords} ` +
          `matched=${result.matched} unmatched=${result.unmatchedCount} skipped=${result.skipped} ` +
          `states=${await getDb().states.count()} 用时=${seconds}s`,
      )
      expect(result.totalRecords).toBe(796)
      expect(result.matched).toBe(735)
      expect(result.unmatchedCount).toBe(61)
      expect(await getDb().states.count()).toBe(735)
      expect(result.pages).toBeGreaterThan(3)
    }, 300_000)

    it('probeMaimemoToken：Token 可用，返回今日进度', async () => {
      const token = readFileSync(TOKEN_PATH, 'utf8').trim()
      expect(token.length).toBeGreaterThan(10)
      setMaimemoSession({ token, proxyUrl: '' })
      const progress = await probeMaimemoToken()
      expect(progress.ok).toBe(true)
      expect(progress.total).toBeGreaterThan(0)
      expect(Number.isFinite(progress.finished)).toBe(true)
      // 绝不打印 token/具体学习数据
      console.log(`[live] maimemo probe ok: total=${progress.total} finished=${progress.finished}`)
    }, 60_000)
  },
)
