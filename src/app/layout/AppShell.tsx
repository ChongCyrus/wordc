import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { bootstrapM2ReadCache, cleanupOldPlans, ensureBuiltinDecks, ensureDefaultContentPacks, ensureDefaultGeneratedData, resumeIncompletePacks,
  seedContentFromAsset,
  readContentCounts,
  DEFAULT_PACKS_META_KEY,
  DEFAULT_PACKS_VERSION,
  applyContentKvToIdbCacheLight, getIdbFactCounts, ensureM4b0Schema, healTodayPlanAfterStartup, markStartupPhase, requestSourceRecovery, getLearningWriteSource, shouldReloadForSourceRecovery, recoverInterruptedWriteSource, ensureLegacyIdbMigratedToSqlite, createFactsPreBackup, ensureRootEtymologyPreinstall, getSettings, restoreSettingsWriteMode, setContentBackupStorage, runContentAutoBackup, scheduleStateCheckpoint, setSettingsCheckpointScheduler, setSqliteFactsCheckpointBridge, flushSqliteFactsCheckpointAuto, ensureContentSourceV15, CONTENT_SOURCE_V15_EVENT, consumeInterruptedContentRestore, isContentMigrationV15Done, hasDurableContentMigrationV15Marker } from '../../data'
import { TAB_ITEMS, tabForPath } from '../routes'
import { useToast } from '../toast'
import { createAutoBackupBridge, createPreBackup, ensurePersistentStorage, restoreProgressCheckpointIfEmpty } from '../utils/auto-backup-service'
import { createContentBackupStorage } from '../utils/content-backup-storage'
import { isContentDowngradeError, CONTENT_DOWNGRADE_MESSAGE } from '../utils/content-errors'
import type { NavIcon } from '../routes'
import { AutoBackupStartupGate } from '../../ui/me/AutoBackupStartupGate'
import { GeneratedSeedIndicator } from '../../ui/components/GeneratedSeedIndicator'
import {
  BookIcon,
  ChartIcon,
  DecksIcon,
  HomeIcon,
  MeIcon,
} from '../../ui/components/icons'

/** 0.17.8：v15 迁移结果信号（seed 必须等它，不能按固定时间点猜） */
let v15SettledResolve: ((ok: boolean) => void) | null = null
const v15SettledPromise = new Promise<boolean>((resolve) => { v15SettledResolve = resolve })

/** 0.16.6：内置词库 seed 完成信号。v15 迁移必须等它结束，否则原生调用会排在 seed 后面超时。 */
let decksReadyResolve: (() => void) | null = null
const decksReadyPromise = new Promise<void>((resolve) => {
  decksReadyResolve = resolve
})

function TabIcon({ icon }: { icon: NavIcon }) {
  switch (icon) {
    case 'home':
      return <HomeIcon className="tabbar-icon" />
    case 'decks':
      return <DecksIcon className="tabbar-icon" />
    case 'stats':
      return <ChartIcon className="tabbar-icon" />
    case 'me':
      return <MeIcon className="tabbar-icon" />
    default:
      return <BookIcon className="tabbar-icon" />
  }
}

/**
 * 全局骨架：内容区 + 底部 Tab 栏。
 * - 一级页面（首页/词库/统计/我的）显示 Tab；
 * - 学习页 / 词库详情 / 设置 / 关于 为沉浸式或二级页，不显示 Tab。
 * 安全区由各页面/TabBar 自行处理。
 */
export function AppShell() {
  const { pathname } = useLocation()
  const toast = useToast()
  const isImmersive = pathname === '/study'
  const [contentMigrating, setContentMigrating] = useState(false)
  const [contentRestoreInterrupted, setContentRestoreInterrupted] = useState(false)
  const [contentMigrationFailed, setContentMigrationFailed] = useState<string | null>(null)

  // 首次启动种入内置词库（幂等、并发安全；失败时由各页面自身空态兜底）
  // 并清理 7 天前的旧今日计划（SPEC-v2 §6.4，幂等、失败不阻塞）
  // 最后自动导入内置内容包（task-87：公开版大纲 pack；幂等、离线失败下次重试，fire-and-forget 不阻塞首屏）
  useEffect(() => {
    const bridge = createAutoBackupBridge()
    setContentBackupStorage(createContentBackupStorage(bridge))
    let contentInterval: ReturnType<typeof setInterval> | null = null
    const contentStart = setTimeout(() => {
      void runContentAutoBackup().then((result) => {
        if (result.ok) return
        if (isContentDowngradeError(result.error)) toast.error(CONTENT_DOWNGRADE_MESSAGE)
      }).catch((error) => {
        if (isContentDowngradeError(error)) toast.error(CONTENT_DOWNGRADE_MESSAGE)
      })
      contentInterval = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return
        void runContentAutoBackup().then((result) => {
        if (result.ok) return
        if (isContentDowngradeError(result.error)) toast.error(CONTENT_DOWNGRADE_MESSAGE)
      }).catch((error) => {
        if (isContentDowngradeError(error)) toast.error(CONTENT_DOWNGRADE_MESSAGE)
      })
      }, 30 * 60 * 1000)
    }, 7_000)
    setSettingsCheckpointScheduler(() => scheduleStateCheckpoint(bridge))
    setSqliteFactsCheckpointBridge(bridge)
    const flush = () => {
      void flushSqliteFactsCheckpointAuto()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(contentStart)
      if (contentInterval) clearInterval(contentInterval)
      window.removeEventListener('pagehide', flush)
      setSettingsCheckpointScheduler(null)
      setSqliteFactsCheckpointBridge(null)
    }
  }, [])

  // 0.16：启动对账——SQLite facts 非空但写源 readonly/IDB cache 空时，强制以 SQLite 重建并刷新
  useEffect(() => {
    let cancelled = false
    const before: 'idb' | 'sqlite' | 'readonly' = getLearningWriteSource()
    const RELOAD_ONCE_KEY = 'momo:sourceRecoveryReloaded'
    void requestSourceRecovery('startup-reload-check').then((after: 'idb' | 'sqlite' | 'readonly') => {
      if (cancelled) return
      const already = (() => { try { return sessionStorage.getItem(RELOAD_ONCE_KEY) === '1' } catch { return true } })()
      if (!shouldReloadForSourceRecovery(before, after, already)) return
      try { sessionStorage.setItem(RELOAD_ONCE_KEY, '1') } catch { return }
      window.location.reload()
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  // 0.15：原生 SQLite 单一事实源 — v15 一次性内容迁移。
  // 首帧后延迟触发（不阻塞首屏）；Web/非原生直接 skipped；失败保持 IDB 可读并自动重试 1 次。
  useEffect(() => {
    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const runV15 = async (attempt: number): Promise<void> => {
      let overlayTimer: ReturnType<typeof setTimeout> | null = attempt === 1 ? setTimeout(() => setContentMigrating(true), 2_500) : null
      const clearOverlay = () => {
        if (overlayTimer != null) { clearTimeout(overlayTimer); overlayTimer = null }
        setContentMigrating(false)
      }
      // 0.16.6：等内置词库 seed 完成，避免 v15 的 SQLite 调用排在 1.2 万条写入之后超时
      await decksReadyPromise.catch(() => undefined)
      const result = await ensureContentSourceV15({
        preBackup: async () => {
          const backup = await createPreBackup()
          return { ok: backup.ok, ...(backup.error ? { error: backup.error } : {}) }
        },
      }).catch((error: unknown) => ({
        ok: false as const,
        source: 'idb' as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      clearOverlay()
      if (cancelled) return
      try {
        window.dispatchEvent(new CustomEvent(CONTENT_SOURCE_V15_EVENT, { detail: result }))
      } catch {
        /* ignore */
      }
      v15SettledResolve?.(Boolean(result.ok))
      if (result.ok) { setContentMigrationFailed(null); return }
      try {
        window.localStorage.setItem('momo:content-v15-diag', JSON.stringify({ at: Date.now(), attempt, ...result }))
      } catch {
        /* ignore */
      }
      // 启动期失败：静默重试（不重复显示遮罩），等 preinstall/packs 等写入结束后再迁移；最多 4 次。
      if (!cancelled && attempt < 4) {
        const delay = Math.min(10_000, 2_000 * attempt)
        timers.push(setTimeout(() => { if (!cancelled) void runV15(attempt + 1) }, delay))
        return
      }
      // 4 次仍失败：不再无限重试/永久遮罩；保留 IDB 可读，给出可关闭出口，下次启动再试。
      setContentMigrationFailed(result.error ?? '内容迁移未完成')
    }
    timers.push(setTimeout(() => { void runV15(1) }, 5_000))
    return () => {
      cancelled = true
      for (const timer of timers) clearTimeout(timer)
    }
  }, [])

  // P1-4：内容恢复被 kill 后首次启动只做引导，不从半替换 kv 自动重建
  useEffect(() => {
    void consumeInterruptedContentRestore()
      .then((result) => setContentRestoreInterrupted(result.interrupted))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    markStartupPhase('effect')
    // 0.11.0 启动性能打点（data/startup-timing，随诊断包导出）
    // 0.11.0 M4b-0：先完成 SQLite schema 升级/门禁，再 bootstrap 读缓存；串行避免 onUpgrade 锁竞争。
    const startupSqlite = (async () => {
      try {
        const expectedCounts = await getIdbFactCounts()
        await ensureM4b0Schema({ expectedCounts })
        markStartupPhase('m4b0')
      } catch (error) {
        try {
          window.localStorage.setItem(
            'momo:m4b0-schema-diag',
            JSON.stringify({ at: Date.now(), error: error instanceof Error ? error.message : String(error) }),
          )
        } catch {
          /* ignore */
        }
      }
      const upgrade = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => { const r = await createFactsPreBackup(createAutoBackupBridge()); return { ok: r.ok, ...(r.error ? { error: r.error } : {}) } } }).catch((error: unknown) => ({ mode: 'failed' as const, error: error instanceof Error ? error.message : String(error) }))
      if (upgrade.mode === 'failed') {
        try { window.localStorage.setItem('momo:legacy-upgrade-diag', JSON.stringify({ at: Date.now(), ...upgrade })) } catch { /* ignore */ }
      }
      await bootstrapM2ReadCache().catch((error) => {
        try {
          window.localStorage.setItem(
            'momo:m2-bootstrap-diag',
            JSON.stringify({ at: Date.now(), error: error instanceof Error ? error.message : String(error) }),
          )
        } catch {
          /* ignore */
        }
      })
      // M4b-1：恢复持久化 settings 写源（失败自动回 IDB 并写 diag）
      // M4b-1：写源恢复与 plan 自愈不阻塞首屏/点击，后台执行
      void restoreSettingsWriteMode().catch(() => undefined)
      void requestSourceRecovery('startup-sqlite')
        .then(() => recoverInterruptedWriteSource())
        .catch(() => undefined)
      void healTodayPlanAfterStartup().catch(() => undefined)
      markStartupPhase('sqlite-background')
    })()
    // 首屏先可交互：重活与 SQLite 升级解耦，延迟到后台执行
    const bootStage = (name: string, extra?: unknown) => {
      let snapshot: unknown[] = []
      try {
        const key = 'momo:boot-stages'
        const prev = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]
        prev.push({ t: Math.round(performance.now()), name, extra })
        snapshot = prev.slice(-40)
        localStorage.setItem(key, JSON.stringify(snapshot))
      } catch { /* ignore */ }
      // 0.17.7：每阶段落盘到 Download/DSH-Go/boot-diag.json，卡住也能看到最后一步
      void (async () => {
        try {
          const { saveBlobFile } = await import('../utils/files')
          let version: string | null = null
          try { version = localStorage.getItem('mm.appVersion') } catch { /* ignore */ }
          const payload = { at: Date.now(), name, version, stages: snapshot }
          await saveBlobFile(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'boot-diag.json', 'application/json')
        } catch { /* ignore */ }
      })()
    }
    // 0.17.6：把启动诊断写到 Download/DSH-Go/boot-diag.json，便于无前台时排查
    const dumpBootDiag = async (tag: string) => {
      try {
        const { saveBlobFile } = await import('../utils/files')
        const counts = await readContentCounts().catch(() => null)
        const payload = {
          at: Date.now(),
          tag,
          version: (() => { try { return localStorage.getItem('mm.appVersion') } catch { return null } })(),
          stages: (() => { try { return JSON.parse(localStorage.getItem('momo:boot-stages') ?? '[]') } catch { return [] } })(),
          content: counts ? { total: counts.total, deleted: counts.deleted, revision: counts.revision } : null,
        }
        await saveBlobFile(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'boot-diag.json', 'application/json')
      } catch { /* 诊断写入失败不影响启动 */ }
    }
    bootStage('chain-start')
    void startupSqlite
    let seededFromAsset = false
    setTimeout(() => {
      void ensurePersistentStorage()
      .catch((error) => {
        try {
          window.localStorage.setItem(
            'momo:persist-diag',
            JSON.stringify({ at: Date.now(), error: error instanceof Error ? error.message : String(error) }),
          )
        } catch {
          /* 记录失败不影响启动 */
        }
      })
      .then(() => { markStartupPhase('persist'); bootStage('persist'); return ensureBuiltinDecks() })
      .then(() => {
        markStartupPhase('decks')
        bootStage('decks-done')
        decksReadyResolve?.()
      })
      .then(async () => {
        const restored = await restoreProgressCheckpointIfEmpty().catch((error: unknown) => ({
          state: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        }))
        if (restored?.state === 'restored' && (restored.restored?.states ?? 0) > 0) {
          toast.success(`已从本地检查点恢复 ${restored.restored?.states ?? 0} 条学习状态`)
        } else if (restored?.state === 'failed') {
          toast.error('检查点恢复失败，可到我的→数据重试')
        }
        markStartupPhase('checkpoint')
        bootStage('checkpoint-done')
        // 0.16.7：plan 清理绝不能阻断预装链；超时/异常都吞掉并记诊断
        bootStage('cleanup-start')
        try {
          await Promise.race([
            cleanupOldPlans({ keepDays: 7 }),
            new Promise((resolve) => setTimeout(resolve, 8_000)),
          ])
          bootStage('cleanup-done')
        } catch (error) {
          bootStage('cleanup-error', error instanceof Error ? error.message : String(error))
          try {
            window.localStorage.setItem('momo:cleanup-plans-diag', JSON.stringify({ at: Date.now(), error: error instanceof Error ? error.message : String(error) }))
          } catch { /* ignore */ }
        }
      })
      // 0.7.5：rootEtymology 预装只调一次（单飞），且不依赖内容包/autoSeed；
      // 失败写入 meta 供下次重试，后台执行不阻塞首屏。
      .then(async () => {
        // 0.17：内容空库 + 原生 APK → 先用内置 seed 库一次性灌入（1~3 秒），成功则跳过三条预装链
        seededFromAsset = false
        bootStage('seed-block-start')
        try {
          bootStage('seed-counts-start')
          // 等 v15 结束（事件驱动），最多 60s；避免按固定时间点误判
          bootStage('seed-wait-v15')
          await Promise.race([v15SettledPromise, new Promise((resolve) => setTimeout(resolve, 60_000))])
          bootStage('seed-v15-settled')
          const counts = await readContentCounts().catch(() => null)
          const liveContent = counts ? Math.max(0, counts.total - counts.deleted) : -1
          bootStage('seed-counts-done', { liveContent })
          // 0.17.5：改用纯原生 durable marker，避免 IDB 读路径卡住整条链
          const v15Ready = await hasDurableContentMigrationV15Marker().catch(() => false)
          bootStage('seed-v15-check', { v15Ready })
          if (liveContent === 0 && v15Ready) {
            bootStage('seed-call-start')
            const seeded = await seedContentFromAsset()
            bootStage('seed-result', seeded)
            await dumpBootDiag('seed-done')
            seededFromAsset = seeded.ok && seeded.contentRows > 0
            if (seededFromAsset) {
              // 标记默认包已就绪，避免下次启动再走语义包导入
              try {
                const { getDb } = await import('../../data/db')
                await getDb().meta.put({ key: DEFAULT_PACKS_META_KEY, value: { version: DEFAULT_PACKS_VERSION, at: Date.now(), seeded: 'asset' }, updatedAt: Date.now() })
              } catch { /* ignore */ }
              // seed 直接写 SQLite，必须重建 IDB cache 才能让 Dexie 读路径看到内容
              try {
                // seed 直写 SQLite content_kv → 必须重建「内容 cache」（不是事实 cache）
                const rebuilt = await applyContentKvToIdbCacheLight()
                bootStage('content-cache-rebuild', rebuilt)
              } catch (error) {
                bootStage('content-cache-rebuild-error', error instanceof Error ? error.message : String(error))
              }
            }
            try {
              window.localStorage.setItem('momo:seed-diag', JSON.stringify({ at: Date.now(), ...seeded }))
            } catch { /* ignore */ }
          }
        } catch (error) { bootStage('seed-error', error instanceof Error ? error.message : String(error)) }
        if (seededFromAsset) return
        const runRootPreinstall = () => {
          setTimeout(() => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
            void isContentMigrationV15Done().then((ready) => {
              // v15 未完成时不要写 IDB overlay，否则会让迁移指纹持续变化而反复失败
              if (ready) void ensureRootEtymologyPreinstall({ nativeOnly: true }).catch(() => undefined)
            }).catch(() => undefined)
          }, 3000)
        }
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
          document.addEventListener('visibilitychange', runRootPreinstall, { once: true })
        } else {
          runRootPreinstall()
        }
      })
      // task-270：私版预生成数据必须在内容包 apply 之后导入（本义匹配依赖 effective coreSenses）
      .then(async () => {
        // 0.11.0 启动性能：内容包 apply 是重活，首帧后延迟，避免冷启动阻塞点击。
        await new Promise((resolve) => setTimeout(resolve, 3000))
        if (!(await isContentMigrationV15Done())) return
        markStartupPhase('packs-start')
        bootStage('packs-start', { seededFromAsset })
        await dumpBootDiag('packs-start')
        // 0.16.3：首启先导语义包（本义/词根依赖），大体积例句包推迟到预生成数据之后再后台补。
        const DEFERRED_PACK_IDS = ['dagang-examples-phrases-full']
        if (seededFromAsset) {
          // 0.17：内容已由 seed 就绪 → 只后台补例句包，跳过语义包/迁移/预生成数据
          markStartupPhase('packs')
          markStartupPhase('startup-done')
          setTimeout(() => {
            void ensureDefaultContentPacks({ force: true, onlyIds: DEFERRED_PACK_IDS }).catch(() => undefined)
          }, 20_000)
          return
        }
        const packs = await ensureDefaultContentPacks({ deferIds: DEFERRED_PACK_IDS })
        markStartupPhase('packs')
        // 0.16.5：断点续传——上次导入被冻结/杀进程打断时，继续把未应用条目跑完（幂等，不阻塞首屏）
        void resumeIncompletePacks().catch(() => undefined)
        markStartupPhase('startup-done')
        if (!packs.ok) return
        // 0.3.92：默认不自动预装（data.generatedAutoSeed=false）；手动按钮走 forceImportDefaultGeneratedData
        const settings = await getSettings()
        if (settings['data.generatedAutoSeed'] !== true) return
        // 0.16.3：预生成数据启动后，后台补导被推迟的例句包（不阻塞本义/引申图就绪）。
        // 每次启动重试，完成一次后记 localStorage，避免重复全量 reapply。
        const DEFERRED_DONE_KEY = 'momo:deferredPacks:examples:v1'
        const runDeferredPacks = () => {
          try {
            if (localStorage.getItem(DEFERRED_DONE_KEY) === '1') return
          } catch {
            /* localStorage 不可用则照常尝试 */
          }
          void ensureDefaultContentPacks({ force: true, onlyIds: DEFERRED_PACK_IDS })
            .then((result) => {
              if (result.ok) {
                try {
                  localStorage.setItem(DEFERRED_DONE_KEY, '1')
                } catch {
                  /* ignore */
                }
              }
            })
            .catch(() => undefined)
        }
        setTimeout(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            document.addEventListener('visibilitychange', function onVisible() {
              if (document.visibilityState !== 'visible') return
              document.removeEventListener('visibilitychange', onVisible)
              runDeferredPacks()
            })
            return
          }
          runDeferredPacks()
        }, 20_000)
        // 首帧后延迟 2.5s 且页面可见才导入预生成数据，避免阻塞路由/点击
        const run = () => {
          setTimeout(() => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
            void ensureDefaultGeneratedData({ autoMode: true })
          }, 2500)
        }
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
          document.addEventListener('visibilitychange', run, { once: true })
        } else {
          run()
        }
      })
      .catch(() => undefined)
    }, 150)
  }, [])
  const activeTab = tabForPath(pathname)
  const showTabBar = activeTab != null && !isImmersive

  return (
    <div className="app-shell">
      {contentMigrationFailed ? (
        <div role="alert" style={{ position: 'sticky', top: 0, zIndex: 9999, background: '#7a4b00', color: '#fff', padding: '10px 14px', fontSize: 13, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span style={{ flex: 1 }}>内容迁移未完成，当前继续使用 IDB 内容（不会锁死）。可稍后重启应用重试，或到“我的 → 数据”备份后反馈诊断。</span>
          <button type="button" onClick={() => setContentMigrationFailed(null)} style={{ background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.7)', borderRadius: 6, padding: '2px 8px' }}>关闭</button>
        </div>
      ) : null}
      {contentRestoreInterrupted ? (
        <div role="alert" style={{ position: 'sticky', top: 0, zIndex: 9999, background: '#8a2b2b', color: '#fff', padding: '10px 14px', fontSize: 13 }}>
          上次内容恢复被中断，内容可能不完整。请先到 <Link to="/me" style={{ color: '#fff', textDecoration: 'underline' }}>我的 → 数据</Link> 恢复备份，再继续编辑。
        </div>
      ) : null}
      <main className={`app-main${isImmersive ? ' app-main--immersive' : ''}`} id="main">
        <Outlet />
      </main>
      {contentMigrating ? (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.55)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            color: '#fff', gap: 12, padding: 24, textAlign: 'center',
          }}
        >
          <strong>正在完成内容迁移…</strong>
          <span>首次升级需要 1–2 分钟，期间不能评分；完成后自动继续。</span>
        </div>
      ) : null}
      {showTabBar ? <TabBar pathname={pathname} /> : null}
      <AutoBackupStartupGate />
      <GeneratedSeedIndicator />
    </div>
  )
}

export function TabBar({ pathname }: { pathname: string }) {
  const active = tabForPath(pathname)

  return (
    <nav className="tabbar" aria-label="主导航">
      {TAB_ITEMS.map((item) => {
        const isActive = active?.path === item.path
        return (
          <Link
            key={item.path}
            to={item.path}
            className={`tabbar-item${isActive ? ' is-active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
          >
            <TabIcon icon={item.icon} />
            <span className="tabbar-label">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
