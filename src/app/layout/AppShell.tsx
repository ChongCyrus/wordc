import { useEffect } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { bootstrapM2ReadCache, cleanupOldPlans, ensureBuiltinDecks, ensureDefaultContentPacks, ensureDefaultGeneratedData, getIdbFactCounts, ensureM4b0Schema, healTodayPlanAfterStartup, markStartupPhase, restoreLearningWriteSource, recoverInterruptedWriteSource, ensureLegacyIdbMigratedToSqlite, createFactsPreBackup, ensureRootEtymologyPreinstall, getSettings, restoreSettingsWriteMode, scheduleStateCheckpoint, setSettingsCheckpointScheduler, setSqliteFactsCheckpointBridge, flushSqliteFactsCheckpointAuto } from '../../data'
import { TAB_ITEMS, tabForPath } from '../routes'
import { useToast } from '../toast'
import { createAutoBackupBridge, ensurePersistentStorage, restoreProgressCheckpointIfEmpty } from '../utils/auto-backup-service'
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

  // 首次启动种入内置词库（幂等、并发安全；失败时由各页面自身空态兜底）
  // 并清理 7 天前的旧今日计划（SPEC-v2 §6.4，幂等、失败不阻塞）
  // 最后自动导入内置内容包（task-87：公开版大纲 pack；幂等、离线失败下次重试，fire-and-forget 不阻塞首屏）
  useEffect(() => {
    const bridge = createAutoBackupBridge()
    setSettingsCheckpointScheduler(() => scheduleStateCheckpoint(bridge))
    setSqliteFactsCheckpointBridge(bridge)
    const flush = () => {
      void flushSqliteFactsCheckpointAuto()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      setSettingsCheckpointScheduler(null)
      setSqliteFactsCheckpointBridge(null)
    }
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
      void restoreLearningWriteSource()
        .then(() => recoverInterruptedWriteSource())
        .catch(() => undefined)
      void healTodayPlanAfterStartup().catch(() => undefined)
      markStartupPhase('sqlite-background')
    })()
    // 首屏先可交互：重活与 SQLite 升级解耦，延迟到后台执行
    void startupSqlite
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
      .then(() => { markStartupPhase('persist'); return ensureBuiltinDecks() })
      .then(() => { markStartupPhase('decks') })
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
        return cleanupOldPlans({ keepDays: 7 })
      })
      // 0.7.5：rootEtymology 预装只调一次（单飞），且不依赖内容包/autoSeed；
      // 失败写入 meta 供下次重试，后台执行不阻塞首屏。
      .then(async () => {
        const runRootPreinstall = () => {
          setTimeout(() => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
            void ensureRootEtymologyPreinstall({ nativeOnly: true }).catch(() => undefined)
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
        markStartupPhase('packs-start')
        const packs = await ensureDefaultContentPacks()
        markStartupPhase('packs')
        markStartupPhase('startup-done')
        if (!packs.ok) return
        // 0.3.92：默认不自动预装（data.generatedAutoSeed=false）；手动按钮走 forceImportDefaultGeneratedData
        const settings = await getSettings()
        if (settings['data.generatedAutoSeed'] !== true) return
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
      <main className={`app-main${isImmersive ? ' app-main--immersive' : ''}`} id="main">
        <Outlet />
      </main>
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
