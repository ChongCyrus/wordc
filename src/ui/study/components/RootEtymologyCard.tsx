interface RootEtymologyPart {
  type: 'prefix' | 'root' | 'suffix' | 'other'
  text: string
  meaning: string
  note?: string
}
interface RootEtymology {
  parts: RootEtymologyPart[]
  etymology?: string
  composition?: string
  source: 'ai' | 'manual'
  updatedAt: number
}

export function normalizePartKey(type: string, text: string): string {
  const normalized = String(text ?? '')
    .trim()
    .replace(/^[-–—]+|[-–—]+$/g, '')
    .trim()
    .toLowerCase()
  return `${type}:${normalized}`
}

const TYPE_LABEL: Record<string, string> = {
  prefix: '前缀',
  root: '词根',
  suffix: '后缀',
  other: '其他',
}

/** task-283：注释面词根词缀词源卡片 */
export function RootEtymologyCard({
  data,
  editable = true,
  onEdit,
  partUnfamiliarity = {},
  onPartClick,
}: {
  data: RootEtymology | null
  editable?: boolean
  onEdit?: () => void
  partUnfamiliarity?: Record<string, number>
  onPartClick?: (key: string) => void
}) {
  return (
    <div className="root-etymology-card">
      <div className="root-etymology-head">
        <span className="root-etymology-title">词根词缀词源</span>
        {editable && onEdit ? (
          <button type="button" className="mm-btn mm-btn--sm" onClick={onEdit}>
            {data ? '编辑' : '添加/编辑'}
          </button>
        ) : null}
      </div>
      {data ? (
        <>
          {data.parts.length > 0 ? (
            <>
            <div className="root-etymology-parts">
              {data.parts.map((part, index) => {
                const key = normalizePartKey(part.type, part.text)
                const unfamiliarity = Math.max(0, Math.min(1, partUnfamiliarity[key] ?? 0))
                return (
                  <button
                    type="button"
                    className="root-etymology-part"
                    key={`${part.type}-${part.text}-${index}`}
                    onClick={() => onPartClick?.(key)}
                    aria-label={`标记 ${part.text} 不熟悉`}
                    title={`不熟悉度 ${Math.round(unfamiliarity * 100)}%`}
                    style={{
                      background: `linear-gradient(to right, var(--mm-warning-soft, rgba(224,161,0,.28)) ${Math.round(unfamiliarity * 100)}%, var(--mm-surface-3) ${Math.round(unfamiliarity * 100)}%)`,
                    }}
                  >
                    <span className="root-etymology-part-type">{TYPE_LABEL[part.type] ?? part.type}</span>
                    <span className="root-etymology-part-text">{part.text}</span>
                    <span className="root-etymology-part-meaning">{part.meaning}</span>
                    <span className="root-etymology-part-percent">{Math.round(unfamiliarity * 100)}%</span>
                  </button>
                )
              })}
            </div>
            {onPartClick ? <div className="mm-caption">轻触词根缀可标记不熟悉</div> : null}
            </>
          ) : null}
          {data.etymology ? <div className="mm-caption">词源：{data.etymology}</div> : null}
          {data.composition ? <div className="mm-caption">组合：{data.composition}</div> : null}
        </>
      ) : (
        <div className="mm-caption">暂无词根词缀词源，可手动编辑或 AI 生成。</div>
      )}
    </div>
  )
}
