/**
 * 导航与页面元数据（纯数据，不 import React / 路由运行时，便于单测）。
 * 路由表见 docs/SPEC.md §8.1：底部 Tab = 首页/词库/统计/我的（4 个）；
 * 学习页从首页进入、全屏无 Tab（D38）；词库详情/设置/关于为二级页。
 */
export type NavIcon =
  | 'home'
  | 'book'
  | 'decks'
  | 'stats'
  | 'me'
  | 'settings'
  | 'about'
  | 'today'

export type NavItem = {
  /** 路由 path（HashRouter 下即 #/xxx；含 :param 的为详情页） */
  path: string
  /** 底部 tab 文案（二级页无 Tab） */
  label: string
  /** 页面标题 */
  title: string
  /** 图标标识（AppShell / TabBar 渲染线性 SVG） */
  icon: NavIcon
  /** 是否出现在底部 tab 栏 */
  inTabBar: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '首页', title: '今日', icon: 'home', inTabBar: true },
  { path: '/study', label: '学习', title: '背单词', icon: 'book', inTabBar: false },
  { path: '/today', label: '今日单词', title: '今日单词', icon: 'today', inTabBar: false },
  { path: '/decks', label: '词库', title: '词库', icon: 'decks', inTabBar: true },
  { path: '/decks/:deckId', label: '词库详情', title: '词库', icon: 'decks', inTabBar: false },
  { path: '/stats', label: '统计', title: '统计', icon: 'stats', inTabBar: true },
  { path: '/me', label: '我的', title: '我的', icon: 'me', inTabBar: true },
  { path: '/me/settings', label: '设置', title: '设置', icon: 'settings', inTabBar: false },
  { path: '/me/about', label: '关于', title: '关于', icon: 'about', inTabBar: false },
]

/** 底部 tab 栏项目（4 个：首页/词库/统计/我的） */
export const TAB_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.inTabBar)

/** 所有页面路径（顺序稳定，测试用） */
export const ALL_PATHS: string[] = NAV_ITEMS.map((item) => item.path)

/**
 * 底部 Tab 激活判断：
 * - 一级页（/、/decks、/stats、/me）精确匹配；
 * - 词库详情 /decks/:deckId 归属「词库」Tab；
 * - 其他二级页（/me/settings、/me/about、/study）不归属任何 Tab（隐藏 Tab 栏）。
 */
export function tabForPath(pathname: string): NavItem | undefined {
  const direct = TAB_ITEMS.find((item) => item.path === pathname)
  if (direct) return direct
  if (pathname.startsWith('/decks/')) return TAB_ITEMS.find((item) => item.path === '/decks')
  return undefined
}
