import { useState } from 'react'
import type { TempReviewSummary } from '../../../data'
import { Dialog } from '../../components/Dialog'
import { PageShell } from '../../components/PageShell'
import { Button } from '../../components/Buttons'

const RATING_TEXT: Record<string, string> = { familiar: '认识', vague: '模糊', forgot: '不认识' }

function avg(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value != null)
  if (valid.length === 0) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function pct(value: number | null): string {
  return value == null ? '—' : `${Math.round(value * 100)}%`
}

/** task-278：临时复习汇总（每词评分/前后含义+本义不熟/DHP/用时） */
export function TempReviewSummaryView({
  summary,
  totalWords,
  skipped,
  onBack,
  onApply,
}: {
  summary: TempReviewSummary
  totalWords: number
  skipped: number
  onBack: () => void
  onApply?: () => Promise<void>
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  return (
    <PageShell title="临时复习汇总" backTo="/">
      <div className="mm-card">
        <div className="mm-row-title">完成 {summary.items.length} / {totalWords} 词 · 跳过 {skipped}</div>
        <div className="mm-caption">
          用时 {Math.max(1, Math.round(summary.totalDurationMs / 1000))} 秒 · 记录方式：{summary.recordMode}
          {summary.recordMode === 'rate' ? '（已影响 DHP）' : '（未影响 DHP）'}
          {summary.occurrences ? ` · 本批出现 ${summary.occurrences.length} 次` : ''}
        </div>
      </div>
      <div className="mm-list">
        {summary.items.map((item) => (
          <div className="mm-row" key={`${item.wordId}-${item.durationMs}`}>
            <span className="mm-row-main">
              <span className="mm-row-title">{item.headword}</span>
              <span className="mm-row-sub">
                本次：{item.rating ? (RATING_TEXT[item.rating] ?? item.rating) : '未自评'} · 含义不熟{' '}
                {pct(avg(Object.values(item.before?.meaningFamiliarity ?? {})))} →{' '}
                {pct(avg(Object.values(item.after?.meaningFamiliarity ?? {})))} · 本义不熟{' '}
                {pct(avg((item.before?.coreSenseFamiliarity ?? []).map((row) => row.familiarity)))} →{' '}
                {pct(avg((item.after?.coreSenseFamiliarity ?? []).map((row) => row.familiarity)))} ·{' '}
                {item.dhpAffected ? '影响复习时间' : '不影响复习时间'}
              </span>
            </span>
          </div>
        ))}
        {skipped > 0 ? <div className="mm-caption">另有 {skipped} 词未自评/已跳过</div> : null}
      </div>
      <div className="mm-btn-row">
        <Button variant="primary" block onClick={onBack}>
          回来源页
        </Button>
        {summary.recordMode !== 'rate' && onApply ? (
          <Button variant="soft" block onClick={() => setConfirmOpen(true)}>
            根据本批次调整日后复习计划
          </Button>
        ) : null}
        {summary.recordMode === 'rate' ? (
          <div className="mm-caption">本次评分已影响日后复习计划。</div>
        ) : null}
      </div>
      <Dialog
        open={confirmOpen}
        title="应用本批到日后复习计划？"
        onClose={() => setConfirmOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" disabled={applying} onClick={() => setConfirmOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              disabled={applying}
              onClick={() => {
                void (async () => {
                  setApplying(true)
                  try {
                    await onApply?.()
                    setConfirmOpen(false)
                  } finally {
                    setApplying(false)
                  }
                })()
              }}
            >
              {applying ? '应用中…' : '确认应用'}
            </button>
          </>
        }
      >
        <div className="mm-caption">将把本批 practice 自评/rate-only 评分写入日后复习安排，每日计划不变。</div>
      </Dialog>
    </PageShell>
  )
}
