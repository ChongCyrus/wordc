import { Dialog } from '../../components/Dialog'

export interface SubwordMeaning {
  id: string
  headword: string
  pos?: string
  cn: string
}

/** A9：点击单词弹出「局部/接近词」列表（显示词性/中文；无结果提示） */
export function SubwordDialog({
  open,
  headword,
  loading,
  items,
  onClose,
}: {
  open: boolean
  headword: string
  loading?: boolean
  items: SubwordMeaning[]
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      title={`${headword} 的局部/接近词`}
      onClose={onClose}
      actions={
        <button type="button" className="mm-btn mm-btn--primary" onClick={onClose}>
          关闭
        </button>
      }
    >
      {loading ? (
        <div className="mm-caption">正在查找…</div>
      ) : items.length === 0 ? (
        <div className="mm-caption">没有找到可展示的局部/接近词。</div>
      ) : (
        <div className="mm-list subword-list">
          {items.map((item) => (
            <div className="mm-row" key={item.id}>
              <span className="mm-row-main">
                <span className="mm-row-title">{item.headword}</span>
                <span className="mm-row-sub">
                  {item.pos ? `${item.pos} · ` : ''}
                  {item.cn}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}
