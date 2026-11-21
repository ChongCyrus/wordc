import { Navigate, useSearchParams } from 'react-router-dom'

/** task-268：临时复习复用 StudyPage 全流程，仅按 recordMode 控制评分 */
export default function TempReviewPage() {
  const [params] = useSearchParams()
  const words = params.get('words') ?? ''
  const recordMode = params.get('recordMode') ?? 'rate'
  const returnTo = params.get('returnTo') ?? '/'
  return (
    <Navigate
      to={`/study?tempWords=${encodeURIComponent(words)}&tempRecordMode=${encodeURIComponent(recordMode)}&returnTo=${encodeURIComponent(returnTo)}`}
      replace
    />
  )
}
