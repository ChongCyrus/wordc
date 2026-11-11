import type { RouteObject } from 'react-router-dom'
import { useRoutes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import HomePage from '../ui/home/HomePage'
import TodayPage from '../ui/today/TodayPage'
import StudyPage from '../ui/study/StudyPage'
import DecksPage from '../ui/decks/DecksPage'
import DeckDetailPage from '../ui/decks/DeckDetailPage'
import StatsPage from '../ui/stats/StatsPage'
import MePage from '../ui/me/MePage'
import SettingsPage from '../ui/me/SettingsPage'
import AboutPage from '../ui/me/AboutPage'
import NotFoundPage from '../ui/components/NotFoundPage'

/**
 * 路由表（唯一事实来源，SPEC §8.1）。
 * 新增页面：在这里加一条，同时更新 src/app/routes.ts 的导航元数据。
 */
export const routeChildren: RouteObject[] = [
  { index: true, element: <HomePage /> },
  { path: 'study', element: <StudyPage /> },
  { path: 'today', element: <TodayPage /> },
  { path: 'decks', element: <DecksPage /> },
  { path: 'decks/:deckId', element: <DeckDetailPage /> },
  { path: 'stats', element: <StatsPage /> },
  { path: 'me', element: <MePage /> },
  { path: 'me/settings', element: <SettingsPage /> },
  { path: 'me/about', element: <AboutPage /> },
  { path: '*', element: <NotFoundPage /> },
]

export function AppRoutes() {
  return useRoutes([{ path: '/', element: <AppShell />, children: routeChildren }])
}
