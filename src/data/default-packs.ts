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
  pruneLegacySemanticsPacks,
  pruneSupersededBuiltinSemanticsPacks,
  reapplyPack,
  refreshPackCounts,
} from './packs.repo'
import type { ReapplyProgress } from './packs.repo'

export const DEFAULT_PACKS_META_KEY = 'packs.defaultSeeded'
/** 内置包集合版本：pack 内容/清单变化时 +1，触发重新导入检查（task-88：+私版清单后升到 2） */
export const DEFAULT_PACKS_VERSION = 6
/** task-114：历史内置 semantics pack checksum（0.3.20/0.3.21 设备上已 seed 的旧版；seed 后清理，不误删手工包） */
const LEGACY_BUILTIN_SEMANTICS_CHECKSUMS: readonly string[] = [
  // dagang full v4（domain 修正前/步骤清洗前；当前 6edb5dec 不在列表）
  '137004c4', 'c450b52f', '41f20f56', '6edb5dec',
  // bikao / supplement 旧版（当前 246731a6 / 1551c4f1 不在列表）
  '4d248421', '88cd0130', '246731a6',
  // dagang 旧版（当前 d4e3485a 不在列表）
  '8068fc50', '7f39e181', 'e8e50147', '99ef7a1d', '6eb80012', 'd4e3485a',
]


export interface DefaultContentPackEntry {
  id: string
  /** 相对站点根路径（Vite public 目录） */
  path: string
  kind: PackKind
  /** 目标词库（semantics 迁移用；缺省按路径推断） */
  deckId?: string
  /** 可选包：缺失（404/网络失败）只记为 missing，不阻塞启动/不阻止写版本标记 */
  optional?: boolean
}

/** 公开版内置内容包清单（只带大纲；商业词表包不随公开树分发） */
export const DEFAULT_CONTENT_PACKS: readonly DefaultContentPackEntry[] = [
  { id: 'dagang-semantics-v37', path: 'packs/dagang/semantics-v37-v4.pack.json', kind: 'semantics', deckId: 'kaoyan-2027-dagang' },
  { id: 'dagang-wc-content-full', path: 'packs/dagang/wc-content-full.pack.json', kind: 'mixed' },
]

/**
 * 私版（`VITE_PRIVATE_PACKS=1`）额外内置的商业词表生成包（task-88）。
 * 文件由 `scripts/build-private.sh` 从 `data/packs/dagang/` 复制到 `public/packs/dagang/`；
 * `examples-phrases-full.pack.json` 生成中，**缺失时 optional 跳过**（不阻塞私版启动）。
 */
export const PRIVATE_CONTENT_PACKS: readonly DefaultContentPackEntry[] = [
  {
    id: 'dagang-semantics-full',
    path: 'packs/dagang/semantics-full-5528-v4.pack.json',
    kind: 'semantics',
    deckId: 'kaoyan-2027-dagang',
    optional: true,
  },
  {
    id: 'dagang-examples-phrases-full',
    path: 'packs/dagang/examples-phrases-full.pack.json',
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

/** 当前构建应导入的内置包清单（公开版只有大纲；私版追加商业词表生成包） */
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
  /** 是否含私版商业词表包（默认读 `VITE_PRIVATE_PACKS`；测试可显式传） */
  includePrivate?: boolean
  /** 仅导入这些 id（配合 force 用于后台补导入） */
  onlyIds?: readonly string[]
  /** 推迟导入这些 id（首启先让语义/本义就绪，体积大的例句包后台补） */
  deferIds?: readonly string[]
  /** 进度回调（导入/补审/重应用；供 UI 进度条） */
  onProgress?: (progress: {
    path: string
    phase: 'import' | 'approve' | 'write' | 'apply' | ReapplyProgress['phase']
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

  const entries = getDefaultContentPacks(opts.includePrivate).filter(
    (entry) =>
      (!opts.onlyIds || opts.onlyIds.includes(entry.id)) &&
      (!opts.deferIds || !opts.deferIds.includes(entry.id)),
  )
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
    opts.onProgress?.({ path: entry.path, phase: 'import', done: 0, total: 1 })
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
      // 默认包可能属于任意词库（公开版=大纲；私版可同时有商业词表）→ 跨全部 deck 解析
      const imported = await importContentPack(text, {
        resolveAllDecks: true,
        builtinId: entry.id,
        onProgress: (progress) =>
          opts.onProgress?.({
            path: entry.path,
            phase: progress.phase,
            done: progress.done,
            total: progress.total,
          }),
      })
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
      const applied = await applyApproved(imported.packId, {
        onProgress: (progress) =>
          opts.onProgress?.({ path: entry.path, phase: 'apply', done: progress.done, total: progress.total }),
      })
      opts.onProgress?.({ path: entry.path, phase: 'apply', done: applied.applied, total: applied.applied, applied: applied.applied })
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
  if (allOk) {
    // task-99/0.3.15：v4 本义数据就绪后，自动删除同 deck 的旧 v3 semantics pack（旧链坏文案）。
    // 清理失败不阻塞 seed（UI 仍可手动「替换为 v4 数据」）。
    try {
      await pruneLegacySemanticsPacks()
      await pruneSupersededBuiltinSemanticsPacks(LEGACY_BUILTIN_SEMANTICS_CHECKSUMS)
    } catch {
      // ignore
    }
  }
  return { ok: allOk, skippedVersion: false, imported: importedTotal, applied: appliedTotal, packs, issues }
}

/**
 * 0.16.5：断点续传。启动时把「已导入但未应用完」的内容包继续应用。
 * 场景：首启导入被系统冻结/杀进程打断，pack 处于 reviewing 且仍有 approved/pending 条目。
 * 幂等：applyApproved 只处理 approved，已 applied 的不会重复写入。
 */
export async function resumeIncompletePacks(opts: {
  onProgress?: EnsureDefaultPacksOptions['onProgress']
} = {}): Promise<{ resumed: number; applied: number; packs: string[] }> {
  const db = getDb()
  const packs = await db.packs.toArray()
  const packIds: string[] = []
  let applied = 0
  for (const pack of packs) {
    const counts = pack.counts
    if (!counts) continue
    const unfinished = (counts.approved ?? 0) > 0 || (counts.pending ?? 0) > 0
    if (!unfinished) continue
    packIds.push(pack.id)
    const items = await db.packItems.where('packId').equals(pack.id).toArray()
    const pendingIds = items.filter((item) => item.status === 'pending').map((item) => item.id)
    if (pendingIds.length > 0) await approveItems(pack.id, pendingIds)
    const result = await applyApproved(pack.id, {
      onProgress: (progress) => opts.onProgress?.({ path: pack.id, phase: 'apply', done: progress.done, total: progress.total }),
    })
    applied += result.applied
    await refreshPackCounts(pack.id).catch(() => undefined)
  }
  return { resumed: packIds.length, applied, packs: packIds }
}
