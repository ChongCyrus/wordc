import { useMemo, useState } from 'react'
import type { RootAffixMappingsResult } from '../../../data'

export type RootAffixItem = RootAffixMappingsResult['items'][number]

const TYPE_LABEL: Record<string, string> = {
  prefix: '前缀',
  root: '词根',
  suffix: '后缀',
  other: '其他',
}

/**
 * 0.8.0：加权记忆「只记词根缀」。
 * 呈现形式与普通 w-c 一致：绿色词形 + ↓ + 大字含义；代表词/组合说明沿用例句行样式。
 */
export function RootAffixStage({
  mapping,
  threeTapRecall,
  fontScale = 1,
  onExit,
}: {
  mapping: RootAffixMappingsResult
  threeTapRecall?: boolean
  fontScale?: number
  onExit?: () => void
}) {
  const cards = useMemo(
    () =>
      mapping.items.map((item) =>
        item.kind === 'part'
          ? {
              kind: 'part' as const,
              typeLabel: TYPE_LABEL[item.type] ?? item.type,
              key: item.key,
              value: item.value,
              reps: item.examples ?? [],
            }
          : { kind: 'word' as const, typeLabel: '', key: item.key, value: item.value, reps: [] },
      ),
    [mapping],
  )
  const [index, setIndex] = useState(0)
  const [tapCount, setTapCount] = useState(0)
  const card = cards[Math.min(index, cards.length - 1)]
  const showMeaning = !threeTapRecall || tapCount >= 1
  const canNext = index < cards.length - 1

  const tap = () => {
    if (!threeTapRecall) {
      if (canNext) {
        setIndex((prev) => prev + 1)
        setTapCount(0)
      }
      return
    }
    if (tapCount === 0) {
      setTapCount(1)
      return
    }
    if (canNext) {
      setIndex((prev) => prev + 1)
      setTapCount(0)
    }
  }

  return (
    <div className="memory-stage root-affix-stage" style={{ fontSize: `${Math.round(16 * fontScale)}px` }}>
      <div className="root-affix-stage-progress">
        词根缀 {Math.min(index + 1, cards.length)} / {cards.length}
      </div>
      <div className="memory-tap-hint">轻触卡片，进入下一页</div>
      <div
        className="memory-stage-tap"
        role="button"
        tabIndex={0}
        aria-label={
          showMeaning
            ? `${card?.typeLabel ? `${card.typeLabel} ` : ''}${card?.key}：${card?.value}`
            : `${card?.typeLabel ? `${card.typeLabel} ` : ''}${card?.key}，点击显示含义`
        }
        onClick={tap}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            tap()
          }
        }}
      >
        <div className="wc-card">
          {card?.kind === 'part' ? (
            <div className="root-affix-type">{card.typeLabel}</div>
          ) : null}
          <div className="wc-word">{card?.key}</div>
          {showMeaning ? (
            <>
              <div className="wc-arrow" aria-hidden="true">
                ↓
              </div>
              <div className="wc-cn">{card?.value}</div>
            </>
          ) : (
            <div className="wc-hidden-question-row">
              <span className="wc-hidden-question" aria-hidden="true">?</span>
            </div>
          )}
        </div>
        {showMeaning && card?.reps.length ? (
          <div className="wc-phrases root-affix-reps">
            {card.reps.map((rep) => (
              <span className="wc-phrase-line" key={rep.headword}>
                {rep.headword}
                {rep.meaning ? ` — ${rep.meaning}` : ''}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {onExit ? (
        <button type="button" className="mm-btn mm-btn--sm root-affix-exit" onClick={onExit}>
          退出根缀模式
        </button>
      ) : null}
    </div>
  )
}
