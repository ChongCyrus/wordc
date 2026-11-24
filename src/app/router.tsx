import type { RouteObject } from 'react-router-dom'
import { useRoutes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import HomePage from '../ui/home/HomePage'
import TodayPage from '../ui/today/TodayPage'
import StudyPage from '../ui/study/StudyPage'
import TempReviewPage from '../ui/study/TempReviewPage'
import DecksPage from '../ui/decks/DecksPage'
import DeckDetailPage from '../ui/decks/DeckDetailPage'
import UnitListPage from '../ui/decks/UnitListPage'
import UnitDetailPage from '../ui/decks/UnitDetailPage'
import AdvancedFilterPage from '../ui/decks/AdvancedFilterPage'
import GeneratePage from '../ui/decks/GeneratePage'
import WordDetailPage from '../ui/decks/WordDetailPage'
import RankingPage from '../ui/stats/RankingPage'
import StatsPage from '../ui/stats/StatsPage'
import MePage from '../ui/me/MePage'
import SettingsPage from '../ui/me/SettingsPage'
import GenerationJobsPage from '../ui/me/GenerationJobsPage'
import DebugPage from '../ui/me/DebugPage'
import ImportExportPage from '../ui/me/ImportExportPage'
import AboutPage from '../ui/me/AboutPage'
import NotFoundPage from '../ui/components/NotFoundPage'

/**
 * 路由表（唯一事实来源，SPEC §8.1）。
 * 新增页面：在这里加一条，同时更新 src/app/routes.ts 的导航元数据。
 */
export const routeChildren: RouteObject[] = [
  { index: true, element: <HomePage /> },
  { path: 'study', element: <StudyPage /> },
  { path: 'temp-review', element: <TempReviewPage /> },
  { path: 'today', element: <TodayPage /> },
  { path: 'decks', element: <DecksPage /> },
  { path: 'decks/:deckId', element: <DeckDetailPage /> },
  { path: 'decks/:deckId/units', element: <UnitListPage /> },
  { path: 'decks/:deckId/filter', element: <AdvancedFilterPage /> },
  { path: 'decks/:deckId/generate', element: <GeneratePage /> },
  { path: 'decks/:deckId/units/:chapter', element: <UnitDetailPage /> },
  { path: 'decks/:deckId/words/:wordId', element: <WordDetailPage /> },
  { path: 'stats', element: <StatsPage /> },
  { path: 'stats/ranking', element: <RankingPage /> },
  { path: 'me', element: <MePage /> },
  { path: 'me/settings', element: <SettingsPage /> },
  { path: 'me/jobs', element: <GenerationJobsPage /> },
  { path: 'me/debug', element: <DebugPage /> },
  { path: 'me/import-export', element: <ImportExportPage /> },
  { path: 'me/about', element: <AboutPage /> },
  { path: '*', element: <NotFoundPage /> },
]

export function AppRoutes() {
  return useRoutes([{ path: '/', element: <AppShell />, children: routeChildren }])
}
