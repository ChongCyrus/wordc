import { useState } from 'react'
import { Dialog } from './Dialog'

export type TempRecordMode = 'practice' | 'rate' | 'rate-only'

/** task-263 追加：抽词后选择加入今日计划 / 立即复习 + 记录方式 */
export function ReviewChoiceDialog({
  open,
  count,
  busy,
  onClose,
  onAddToPlan,
  onStartTemp,
}: {
  open: boolean
  count: number
  busy?: boolean
  onClose: () => void
  onAddToPlan: () => void
  onStartTemp: (mode: TempRecordMode) => void
}) {
  const [mode, setMode] = useState<TempRecordMode>('rate')
  return (
    <Dialog
      open={open}
      title={`抽这些词复习（${count}）`}
      onClose={onClose}
      dismissable={!busy}
      actions={
        <>
          <button type="button" className="mm-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="mm-btn" disabled={busy} onClick={onAddToPlan}>
            加入今日计划
          </button>
          <button type="button" className="mm-btn mm-btn--primary" disabled={busy} onClick={() => onStartTemp(mode)}>
            立即复习
          </button>
        </>
      }
    >
      <div className="mm-caption">「加入今日计划」会追加到今日计划；「立即复习」是一次性队列，不改变今日计划。</div>
      <div className="mm-list">
        {(
          [
            ['practice', '只练不记录（不显示评分）'],
            ['rate', '评分并记录（不改变今日计划）'],
            ['rate-only', '评分但不改复习时间'],
          ] as const
        ).map(([value, label]) => (
          <label className="mm-row" key={value}>
            <span className="mm-row-main">
              <span className="mm-row-title">{label}</span>
            </span>
            <input
              type="radio"
              name="temp-record-mode"
              checked={mode === value}
              onChange={() => setMode(value)}
            />
          </label>
        ))}
      </div>
    </Dialog>
  )
}
