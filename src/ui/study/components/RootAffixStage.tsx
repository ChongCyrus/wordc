import { useMemo, useState } from 'react'
import type { RootAffixMappingsResult } from '../../../data'
import { normalizePartKey } from './RootEtymologyCard'

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
  partTotals = {},
  baseTotal = 3,
  partUnfamiliarity = {},
  onExit,
}: {
  mapping: RootAffixMappingsResult
  threeTapRecall?: boolean
  fontScale?: number
  partTotals?: Record<string, number>
  baseTotal?: number
  partUnfamiliarity?: Record<string, number>
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
              total: Math.max(1, Math.min(10, partTotals[normalizePartKey(item.type, item.key)] ?? baseTotal)),
              unfamiliarity: Math.max(0, Math.min(1, partUnfamiliarity[normalizePartKey(item.type, item.key)] ?? 0)),
            }
          : {
              kind: 'word' as const,
              typeLabel: '',
              key: item.key,
              value: item.value,
              reps: [] as Array<{ headword: string; meaning?: string }>,
              total: 1,
              unfamiliarity: 0,
            },
      ),
    [mapping, partTotals, baseTotal, partUnfamiliarity],
  )
  const [index, setIndex] = useState(0)
  const [tapCount, setTapCount] = useState(0)
  const [cardCounts, setCardCounts] = useState<Record<number, number>>({})
  const card = cards[Math.min(index, cards.length - 1)]
  const showMeaning = !threeTapRecall || tapCount >= 1
  const canNext = index < cards.length - 1

  const currentCount = cardCounts[index] ?? 0
  const currentTotal = card?.total ?? 1

  const tap = () => {
    if (threeTapRecall && tapCount === 0) {
      setTapCount(1)
      return
    }
    if (currentCount + 1 < currentTotal) {
      setCardCounts((prev) => ({ ...prev, [index]: currentCount + 1 }))
      return
    }
    setCardCounts((prev) => ({ ...prev, [index]: currentCount + 1 }))
    setTapCount(0)
    if (canNext) setIndex((prev) => prev + 1)
    else onExit?.()
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
        <div
          className="wc-card root-affix-card-fill"
          style={{ '--part-fill': `${Math.round((card?.unfamiliarity ?? 0) * 100)}%` } as React.CSSProperties}
        >
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
        {showMeaning ? (
          <div className="wc-info">
            {card?.kind === 'part' ? (
              <>
                <div className="wc-info-caption">代表词</div>
                {card.reps.length > 0 ? (
                  card.reps.map((rep) => (
                    <div className="wc-info-example" key={rep.headword}>
                      <span className="wc-info-en">{rep.headword}</span>
                      {rep.meaning ? <span className="wc-info-cn">{rep.meaning}</span> : null}
                    </div>
                  ))
                ) : (
                  <div className="wc-info-example"><span className="wc-info-cn">词库暂无匹配代表词</span></div>
                )}
              </>
            ) : (
              <>
                <div className="wc-info-caption">组合</div>
                <div className="wc-info-example"><span className="wc-info-cn">{card?.value}</span></div>
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="wc-count-row">
        <span className="wc-count" key={`${index}-${currentCount}`}>
          {Math.min(currentCount, currentTotal)} / {currentTotal}
        </span>
      </div>
      <div className="wc-dots" aria-hidden="true">
        {Array.from({ length: currentTotal }, (_, dotIndex) => (
          <span key={dotIndex} className={`wc-dot${dotIndex < currentCount ? ' is-filled' : ''}`} />
        ))}
      </div>
    </div>
  )
}
