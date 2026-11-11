/**
 * Dexie v1（SPEC §2.1 逐字落地）。
 *
 * - 表名固定：decks / words / states / reviewLogs / settings / meta（全队按这个名）。
 * - 所有对 IndexedDB 的读写只能出现在 src/data/ 内；UI 读可 `db.decks`（用 useLiveQuery），
 *   写必须走 src/data 导出的函数（SPEC §2.2-5 / §9.4）。
 * - 旧脚手架（arch 占位版 reviewStates/dailyStats）不迁移：开发期 `resetDatabase()` 重建。
 */

import Dexie from 'dexie'
import type { EntityTable } from 'dexie'
import type {
  Deck,
  MetaRecord,
  ReviewLog,
  SettingRecord,
  Word,
  WordState,
} from '../core'
import type { DailyPlan } from './plan.types'
import type { ContentRejectRecord, PackItemRecord, PackRecord } from './packs/schema'

export const DB_NAME = 'momo-reword'

/** 结构版本；meta.schemaVersion 里记录一份，便于以后迁移判断 */
export const SCHEMA_VERSION = 3

export class AppDatabase extends Dexie {
  decks!: EntityTable<Deck, 'id'>
  words!: EntityTable<Word, 'id'>
  states!: EntityTable<WordState, 'wordId'>
  reviewLogs!: EntityTable<ReviewLog, 'id'>
  settings!: EntityTable<SettingRecord, 'key'>
  meta!: EntityTable<MetaRecord, 'key'>
  /** v2 新增：今日学习计划（一天一词库一行；id = `${date}:${deckId}`） */
  plans!: EntityTable<DailyPlan, 'id'>
  /** v3 新增：内容包（momo-pack） */
  packs!: EntityTable<PackRecord, 'id'>
  /** v3 新增：内容包条目（pending/approved/rejected/applied/skipped） */
  packItems!: EntityTable<PackItemRecord, 'id'>
  /** v3 新增：拒绝记忆（❌ 的内容不再推荐/导入） */
  contentRejects!: EntityTable<ContentRejectRecord, 'id'>

  constructor(name: string = DB_NAME) {
    super(name)
    this.version(1).stores({
      // 词库：按来源、更新时间查
      decks: 'id, name, source, builtinKey, updatedAt',
      // 单词：词库内按 order 取；按 headwordLower 查重/搜索；按标签过滤
      words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt',
      // 状态：查「今天到期」/「某词库的新词」/「某阶段」
      states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
      // 日志：统计按时间范围；某词的复习历史
      reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
      settings: 'key',
      meta: 'key',
    })

    // v2（SPEC-v2 §8 / ARCH-v2 §2）：只新增 plans 表，旧表索引不变；**不写 .upgrade()** 全表迁移
    this.version(2).stores({
      decks: 'id, name, source, builtinKey, updatedAt',
      words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt',
      states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
      reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
      settings: 'key',
      meta: 'key',
      plans: 'id, date, deckId, updatedAt, completedAt',
    })

    // v3（SPEC-CONTENT-PACKS §3.1）：内容包三表，旧表索引不变；不写 .upgrade()（新表空开始）
    this.version(3).stores({
      decks: 'id, name, source, builtinKey, updatedAt',
      words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt',
      states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
      reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
      settings: 'key',
      meta: 'key',
      plans: 'id, date, deckId, updatedAt, completedAt',
      packs: 'id, status, kind, source, createdAt, updatedAt',
      packItems: 'id, packId, status, headwordLower, wordId, meaningId, [packId+status], appliedAt',
      contentRejects: 'id, kind, headwordLower, rejectedAt',
    })

    // 打开成功后写 schemaVersion / migratedAt.v2/v3（幂等；ARCH-v2 §2.2）
    this.on('ready', () => {
      void this.writeSchemaMeta().catch(() => {
        // 元数据写入失败不应阻塞 App；ensureSchemaMeta() 会在建队前再兜底一次
      })
    })
  }

  /** 幂等写入 `meta.schemaVersion` / `meta.migratedAt.v2` / `meta.migratedAt.v3` */
  async writeSchemaMeta(now: number = Date.now()): Promise<void> {
    const version = await this.meta.get('schemaVersion')
    if (version?.value === SCHEMA_VERSION) return
    await this.meta.bulkPut([
      { key: 'schemaVersion', value: SCHEMA_VERSION, updatedAt: now },
      {
        key: 'migratedAt.v2',
        value: (await this.meta.get('migratedAt.v2'))?.value ?? now,
        updatedAt: now,
      },
      {
        key: 'migratedAt.v3',
        value: (await this.meta.get('migratedAt.v3'))?.value ?? now,
        updatedAt: now,
      },
    ])
  }
}

let instance: AppDatabase | null = null

/** 单例（浏览器 / 测试环境都由这里拿；测试用 resetDatabase() 隔离） */
export function getDb(): AppDatabase {
  if (!instance) instance = new AppDatabase()
  return instance
}

/**
 * `db` 出口（§9.3）：始终指向**当前**单例的代理，`resetDatabase()` 后仍然可用。
 * 同时把方法绑定到真实实例，避免 `this` 丢失（如 `db.transaction(...)`）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>
    const value = real[prop as string]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value
  },
  has(_target, prop) {
    return prop in getDb()
  },
})

/** 删除整个数据库（开发/测试/「恢复出厂」用；危险操作） */
export async function resetDatabase(name: string = DB_NAME): Promise<void> {
  const current = instance
  instance = null
  if (current) {
    try {
      current.close()
    } catch {
      // 已关闭/已删除都无所谓
    }
  }
  await Dexie.delete(name)
}
