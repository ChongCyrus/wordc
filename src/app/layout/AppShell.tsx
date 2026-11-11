import { useEffect } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { cleanupOldPlans, ensureBuiltinDecks } from '../../data'
import { TAB_ITEMS, tabForPath } from '../routes'
import type { NavIcon } from '../routes'
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
  const isImmersive = pathname === '/study'

  // 首次启动种入内置词库（幂等、并发安全；失败时由各页面自身空态兜底）
  // 并清理 7 天前的旧今日计划（SPEC-v2 §6.4，幂等、失败不阻塞）
  useEffect(() => {
    void ensureBuiltinDecks()
      .then(() => cleanupOldPlans({ keepDays: 7 }))
      .catch(() => undefined)
  }, [])
  const activeTab = tabForPath(pathname)
  const showTabBar = activeTab != null && !isImmersive

  return (
    <div className="app-shell">
      <main className={`app-main${isImmersive ? ' app-main--immersive' : ''}`} id="main">
        <Outlet />
      </main>
      {showTabBar ? <TabBar pathname={pathname} /> : null}
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
