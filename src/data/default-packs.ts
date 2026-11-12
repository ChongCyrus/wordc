/**
 * 内置（随包分发）内容包 + 首次启动自动导入（task-87）。
 *
 * 公开版把大纲词库的 AI 生成内容打包为静态资源：
 *   public/packs/dagang/semantics-v37.pack.json     — 本义/引申链（~623KB）
 *   public/packs/dagang/wc-content-full.pack.json   — 例句/词组/助记（~3.6MB）
 * 首次启动时 fetch → importContentPack → approveItems → applyApproved；
 * 成功后写 `meta.packs.defaultSeeded` 版本标记，之后跳过；离线/失败不阻塞，下次重试。
 *
 * 私仓默认不带 `public/packs`（只有公开树 sanitize 时复制），因此私仓调用会 404 → 返回 ok:false
 * 且不写标记（不阻塞启动）；公开树构建后即生效。
 */

import type { ImportIssue } from '../core'
import { getDb } from './db'
import type { PackKind } from './packs/schema'
import {
  applyApproved,
  approveItems,
  importContentPack,
  listPackItems,
  listPacks,
  reapplyPack,
} from './packs.repo'
import type { ReapplyProgress } from './packs.repo'

export const DEFAULT_PACKS_META_KEY = 'packs.defaultSeeded'
/** 内置包集合版本：pack 内容/清单变化时 +1，触发重新导入检查（task-88：+私版清单后升到 2） */
export const DEFAULT_PACKS_VERSION = 2

export interface DefaultContentPackEntry {
  id: string
  /** 相对站点根路径（Vite public 目录） */
  path: string
  kind: PackKind
  /** 可选包：缺失（404/网络失败）只记为 missing，不阻塞启动/不阻止写版本标记 */
  optional?: boolean
}

/** 公开版内置内容包清单（只带大纲；受限商业词表包不随公开树分发） */
export const DEFAULT_CONTENT_PACKS: readonly DefaultContentPackEntry[] = [
  { id: 'dagang-semantics-v37', path: 'packs/dagang/semantics-v37.pack.json', kind: 'semantics' },
  { id: 'dagang-wc-content-full', path: 'packs/dagang/wc-content-full.pack.json', kind: 'mixed' },
]

/**
 * 私版（`VITE_PRIVATE_PACKS=1`）额外内置的受限商业词表生成包（task-88）。
 * 文件由 `scripts/build-private.sh` 从 `data/packs/hongbaoshu/` 复制到 `public/packs/hongbaoshu/`；
 * `examples-phrases-full.pack.json` 生成中，**缺失时 optional 跳过**（不阻塞私版启动）。
 */
export const PRIVATE_CONTENT_PACKS: readonly DefaultContentPackEntry[] = [
  {
    id: 'hongbaoshu-semantics-full',
    path: 'packs/hongbaoshu/semantics-full-6702.pack.json',
    kind: 'semantics',
    optional: true,
  },
  {
    id: 'hongbaoshu-examples-phrases-full',
    path: 'packs/hongbaoshu/examples-phrases-full.pack.json',
    kind: 'mixed',
    optional: true,
  },
]

/** 构建期私版开关（Vite: `VITE_PRIVATE_PACKS=1`；非 Vite 环境视为关闭） */
export function isPrivatePacksEnabled(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { VITE_PRIVATE_PACKS?: string } }).env
    return env?.VITE_PRIVATE_PACKS === '1'
  } catch {
    return false
  }
}

/** 当前构建应导入的内置包清单（公开版只有大纲；私版追加受限商业词表生成包） */
export function getDefaultContentPacks(includePrivate?: boolean): readonly DefaultContentPackEntry[] {
  const enabled = includePrivate ?? isPrivatePacksEnabled()
  return enabled ? [...DEFAULT_CONTENT_PACKS, ...PRIVATE_CONTENT_PACKS] : DEFAULT_CONTENT_PACKS
}

export interface DefaultPackOutcome {
  id: string
  path: string
  status: 'imported' | 'skipped' | 'failed' | 'missing'
  imported?: number
  applied?: number
  error?: string
}

export interface EnsureDefaultPacksResult {
  ok: boolean
  /** 版本标记已是最新（未发起 fetch） */
  skippedVersion: boolean
  imported: number
  applied: number
  packs: DefaultPackOutcome[]
  issues: ImportIssue[]
}

export interface EnsureDefaultPacksOptions {
  /** 忽略版本标记强制检查/导入（导入本身幂等） */
  force?: boolean
  /** 测试注入 fetch */
  fetchImpl?: typeof fetch
  /** 覆盖站点根（默认 import.meta.env.BASE_URL 或 '/'） */
  baseUrl?: string
  /** 是否含私版受限商业词表包（默认读 `VITE_PRIVATE_PACKS`；测试可显式传） */
  includePrivate?: boolean
  /** 进度回调（导入/补审/重应用；供 UI 进度条） */
  onProgress?: (progress: {
    path: string
    phase: 'import' | 'approve' | 'apply' | ReapplyProgress['phase']
    done: number
    total: number
    retried?: number
    applied?: number
  }) => void
}

function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl) return baseUrl
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
    if (env?.BASE_URL) return env.BASE_URL
  } catch {
    // 非 Vite 环境
  }
  return '/'
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * 首次启动自动导入内置内容包（幂等、可重试、不抛错）。
 * 调用方**不需要 await 阻塞启动**（可 fire-and-forget；失败下次启动重试）。
 */
export async function ensureDefaultContentPacks(
  opts: EnsureDefaultPacksOptions = {},
): Promise<EnsureDefaultPacksResult> {
  const db = getDb()
  const issues: ImportIssue[] = []
  const baseUrl = resolveBaseUrl(opts.baseUrl)

  if (!opts.force) {
    const row = await db.meta.get(DEFAULT_PACKS_META_KEY)
    const value = row?.value as { version?: number } | undefined
    if (value?.version === DEFAULT_PACKS_VERSION) {
      return { ok: true, skippedVersion: true, imported: 0, applied: 0, packs: [], issues }
    }
  }

  const entries = getDefaultContentPacks(opts.includePrivate)
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) {
    return {
      ok: false,
      skippedVersion: false,
      imported: 0,
      applied: 0,
      packs: [],
      issues: [
        {
          level: 'warning',
          code: 'E_IO',
          message: '当前环境不支持 fetch，内置内容包将在下次启动重试',
        },
      ],
    }
  }

  let importedTotal = 0
  let appliedTotal = 0
  let allOk = true
  const packs: DefaultPackOutcome[] = []

  for (const entry of entries) {
    const url = joinUrl(baseUrl, entry.path)
    try {
      const response = await fetchImpl(url)
      if (!response.ok) {
        if (entry.optional && response.status === 404) {
          packs.push({ id: entry.id, path: entry.path, status: 'missing' })
          continue
        }
        throw new Error(`HTTP ${response.status}`)
      }
      const text = await response.text()
      // 默认包可能属于任意词库（公开版=大纲；私版可同时有受限商业词表）→ 跨全部 deck 解析
      const imported = await importContentPack(text, { resolveAllDecks: true })
      if (!imported.ok) {
        const message = imported.issues.map((issue) => issue.message).join('；') || '内容包导入失败'
        allOk = false
        packs.push({ id: entry.id, path: entry.path, status: 'failed', error: message })
        issues.push(...imported.issues)
        continue
      }
      opts.onProgress?.({ path: entry.path, phase: 'import', done: 1, total: 1 })
      if (imported.packId && imported.reused) {
        // task-92：同 checksum 已存在 → 不重复导入，只补审 pending + 重应用 skipped
        const items = await listPackItems(imported.packId)
        const pendingIds = items.filter((item) => item.status === 'pending').map((item) => item.id)
        if (pendingIds.length > 0) await approveItems(imported.packId, pendingIds)
        opts.onProgress?.({ path: entry.path, phase: 'approve', done: 1, total: 1 })
        const reapplied = await reapplyPack(imported.packId, {
          ...(imported.deckId ? { deckId: imported.deckId } : {}),
          onProgress: (progress) =>
            opts.onProgress?.({
              path: entry.path,
              phase: progress.phase,
              done: progress.done,
              total: progress.total,
              retried: progress.retried,
            }),
        })
        appliedTotal += reapplied.applied
        packs.push({
          id: entry.id,
          path: entry.path,
          status: reapplied.applied > 0 ? 'imported' : 'skipped',
          imported: 0,
          applied: reapplied.applied,
        })
        continue
      }
      if (!imported.packId) {
        // 内容已存在（幂等重试/重复启动）。
        // task-90：若旧 pack 因 deck 解析错误留下 skipped 条目，force/修复后自动 reapply。
        let retriedApplied = 0
        if (imported.checksum) {
          const existing = (await listPacks()).find((pack) => pack.checksum === imported.checksum)
          if (existing) {
            const reapplied = await reapplyPack(existing.id, {
              ...(existing.deckId ? { deckId: existing.deckId } : {}),
            })
            retriedApplied = reapplied.applied
            if (retriedApplied > 0) appliedTotal += retriedApplied
          }
        }
        packs.push({ id: entry.id, path: entry.path, status: 'skipped', applied: retriedApplied })
        continue
      }
      const items = await listPackItems(imported.packId)
      const pendingIds = items.filter((item) => item.status === 'pending').map((item) => item.id)
      if (pendingIds.length > 0) await approveItems(imported.packId, pendingIds)
      opts.onProgress?.({ path: entry.path, phase: 'approve', done: 1, total: 1 })
      const applied = await applyApproved(imported.packId)
      opts.onProgress?.({ path: entry.path, phase: 'apply', done: 1, total: 1, applied: applied.applied })
      importedTotal += imported.preview.counts.matched
      appliedTotal += applied.applied
      packs.push({ id: entry.id, path: entry.path, status: 'imported', imported: imported.preview.counts.matched, applied: applied.applied })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (entry.optional) {
        // 私版可选包（生成中/未随当前构建分发）：跳过，不阻塞启动、不阻止写版本标记
        packs.push({ id: entry.id, path: entry.path, status: 'missing', error: message })
        continue
      }
      allOk = false
      packs.push({ id: entry.id, path: entry.path, status: 'failed', error: message })
      issues.push(
        {
          level: 'warning',
          code: 'E_IO',
          message: `内置内容包 ${entry.id} 加载失败（${message}），下次启动会重试`,
          path: entry.path,
        },
      )
    }
  }

  if (allOk) {
    await db.meta.put({
      key: DEFAULT_PACKS_META_KEY,
      value: {
        version: DEFAULT_PACKS_VERSION,
        at: Date.now(),
        packs: packs.map((pack) => ({ id: pack.id, status: pack.status })),
      },
      updatedAt: Date.now(),
    })
  }
  return { ok: allOk, skippedVersion: false, imported: importedTotal, applied: appliedTotal, packs, issues }
}
