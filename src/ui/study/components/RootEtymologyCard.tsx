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
}: {
  data: RootEtymology | null
  editable?: boolean
  onEdit?: () => void
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
            <div className="root-etymology-parts">
              {data.parts.map((part, index) => (
                <span className="root-etymology-part" key={`${part.type}-${part.text}-${index}`}>
                  <span className="root-etymology-part-type">{TYPE_LABEL[part.type] ?? part.type}</span>
                  <span className="root-etymology-part-text">{part.text}</span>
                  <span className="root-etymology-part-meaning">{part.meaning}</span>
                </span>
              ))}
            </div>
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
