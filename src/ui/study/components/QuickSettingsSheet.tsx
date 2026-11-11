import { useState } from 'react'
import type { SettingsMap } from '../../../core'

export interface QuickSettingsSheetProps {
  settings: SettingsMap
  onPatch: (patch: Partial<SettingsMap>) => void
  /** 每日学习量（task-35：需走 data resync，不直接 onPatch） */
  onDailyGoalChange?: (goal: number) => void
  onClose: () => void
}

/**
 * 学习页内快捷设置（⋮ → 记忆设置）：改动立即写数据层并实时作用于当前会话（AC4）。
 * 完整设置项在 /me/settings（task-10）。
 */
export function QuickSettingsSheet({
  settings,
  onPatch,
  onDailyGoalChange,
  onClose,
}: QuickSettingsSheetProps) {
  const totalRepeats = settings['memory.totalRepeats']
  const dailyGoal = settings['study.dailyGoal']
  const [goalDraft, setGoalDraft] = useState(String(dailyGoal))
  const goalValue = Number(goalDraft)
  const goalValid = Number.isInteger(goalValue) && goalValue >= 1 && goalValue <= 9999
  const goalChanged = goalValid && goalValue !== dailyGoal
  const mode = settings['memory.mode']
  const showPhrases = settings['memory.showPhrases']
  const fontScale = settings['memory.fontScale']

  return (
    <div className="study-sheet-mask" onClick={onClose} role="presentation">
      <div
        className="study-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="记忆设置"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="study-sheet-title">记忆设置（实时生效）</div>
        <div className="study-setting-list">
          {onDailyGoalChange ? (
            <div className="study-setting-row">
              <span className="study-setting-label">
                每日学习量
                <span className="study-setting-hint">今日计划会立即按新目标调整</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  className="mm-input"
                  style={{ width: 84, minHeight: 36, textAlign: 'center' }}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={9999}
                  step={1}
                  value={goalDraft}
                  aria-label="每日学习量"
                  onChange={(event) => setGoalDraft(event.target.value)}
                />
                <button
                  type="button"
                  className="study-btn study-btn--primary"
                  style={{ minHeight: 36, padding: '0 12px', fontSize: 14 }}
                  disabled={!goalChanged}
                  onClick={() => {
                    if (goalValid) onDailyGoalChange(goalValue)
                  }}
                >
                  应用
                </button>
              </span>
            </div>
          ) : null}
          <div className="study-setting-row">
            <span className="study-setting-label">
              记忆总次数
              <span className="study-setting-hint">每个含义记忆几次</span>
            </span>
            <div className="study-stepper">
              <button
                type="button"
                className="study-stepper-btn"
                aria-label="减少记忆次数"
                disabled={totalRepeats <= 1}
                onClick={() => onPatch({ 'memory.totalRepeats': Math.max(1, totalRepeats - 1) })}
              >
                −
              </button>
              <span className="study-stepper-value">{totalRepeats}</span>
              <button
                type="button"
                className="study-stepper-btn"
                aria-label="增加记忆次数"
                disabled={totalRepeats >= 10}
                onClick={() => onPatch({ 'memory.totalRepeats': Math.min(10, totalRepeats + 1) })}
              >
                ＋
              </button>
            </div>
          </div>

          <div className="study-setting-row">
            <span className="study-setting-label">
              记忆模式
              <span className="study-setting-hint">默认按顺序，随机从未满中挑</span>
            </span>
            <div className="study-seg" role="group" aria-label="记忆模式">
              <button
                type="button"
                className={`study-seg-btn${mode === 'sequential' ? ' is-active' : ''}`}
                onClick={() => onPatch({ 'memory.mode': 'sequential' })}
              >
                默认
              </button>
              <button
                type="button"
                className={`study-seg-btn${mode === 'random' ? ' is-active' : ''}`}
                onClick={() => onPatch({ 'memory.mode': 'random' })}
              >
                随机
              </button>
            </div>
          </div>

          <div className="study-setting-row">
            <span className="study-setting-label">
              显示词组
              <span className="study-setting-hint">w-c 页显示含单词/含义的词组</span>
            </span>
            <button
              type="button"
              className={`study-switch${showPhrases ? ' is-on' : ''}`}
              role="switch"
              aria-checked={showPhrases}
              aria-label="显示词组"
              onClick={() => onPatch({ 'memory.showPhrases': !showPhrases })}
            >
              <span className="study-switch-knob" />
            </button>
          </div>

          <div className="study-setting-row">
            <span className="study-setting-label">
              w-c 字号
              <span className="study-setting-hint">当前 ×{fontScale.toFixed(2)}</span>
            </span>
            <input
              className="study-slider"
              type="range"
              min={0.8}
              max={1.6}
              step={0.05}
              value={fontScale}
              aria-label="w-c 字号"
              onChange={(event) =>
                onPatch({ 'memory.fontScale': Number(event.target.value) })
              }
            />
          </div>
        </div>

        <div className="study-dialog-actions" style={{ marginTop: 12 }}>
          <button type="button" className="study-btn study-btn--primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
