import { useState } from 'react'
import type { ReactNode } from 'react'

export interface BulkOption<T extends string> {
  value: T
  label: string
}

export interface BulkSelectToolbarProps<T extends string> {
  query: string
  onQueryChange: (value: string) => void
  searchLabel?: string
  sort: T
  sortOptions: Array<BulkOption<T>>
  onSortChange: (value: T) => void
  filter?: string
  filterOptions?: Array<{ value: string; label: string }>
  onFilterChange?: (value: string) => void
  selectedCount: number
  total: number
  onSelectAll: () => void
  onInvert: () => void
  onClear: () => void
  extra?: ReactNode
  /** task-268：按当前筛选+排序选择前 N 个 */
  onSelectFirstN?: (count: number) => void
  direction?: 'asc' | 'desc'
  onDirectionChange?: (value: 'asc' | 'desc') => void
  dimension?: string
  dimensionOptions?: Array<{ value: string; label: string }>
  onDimensionChange?: (value: string) => void
}

/** task-261 C：通用批量选择/筛选工具条（跨分页由调用方 ids API 负责） */
export function BulkSelectToolbar<T extends string>({
  query,
  onQueryChange,
  searchLabel = '搜索',
  sort,
  sortOptions,
  onSortChange,
  filter,
  filterOptions,
  onFilterChange,
  selectedCount,
  total,
  onSelectAll,
  onInvert,
  onClear,
  extra,
  onSelectFirstN,
  direction,
  onDirectionChange,
  dimension,
  dimensionOptions,
  onDimensionChange,
}: BulkSelectToolbarProps<T>) {
  const [firstN, setFirstN] = useState('50')
  return (
    <div className="bulk-toolbar">
      <input
        className="mm-input"
        aria-label={searchLabel}
        placeholder={`${searchLabel}（英文/中文）`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="bulk-toolbar-row">
        {filter && filterOptions && onFilterChange ? (
          <select
            className="mm-input bulk-toolbar-select"
            aria-label="状态筛选"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
          >
            {filterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        <select
          className="mm-input bulk-toolbar-select"
          aria-label="排序"
          value={sort}
          onChange={(event) => onSortChange(event.target.value as T)}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {dimension && dimensionOptions && onDimensionChange ? (
          <select
            className="mm-input bulk-toolbar-select"
            aria-label="不熟悉度维度"
            value={dimension}
            onChange={(event) => onDimensionChange(event.target.value)}
          >
            {dimensionOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        {direction && onDirectionChange ? (
          <select
            className="mm-input bulk-toolbar-select"
            aria-label="排序方向"
            value={direction}
            onChange={(event) => onDirectionChange(event.target.value as 'asc' | 'desc')}
          >
            <option value="asc">升序</option>
            <option value="desc">降序</option>
          </select>
        ) : null}
        {extra}
      </div>
      <div className="bulk-toolbar-row">
        <button type="button" className="mm-btn mm-btn--sm" onClick={onSelectAll}>
          全选
        </button>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onInvert}>
          反选
        </button>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onClear}>
          取消全选
        </button>
        {onSelectFirstN ? (
          <>
            <input
              className="mm-input bulk-toolbar-first-n"
              aria-label="选择前 N 个数量"
              inputMode="numeric"
              value={firstN}
              onChange={(event) => setFirstN(event.target.value)}
            />
            <button
              type="button"
              className="mm-btn mm-btn--sm"
              onClick={() => {
                const n = Math.max(1, Math.min(999, Number.parseInt(firstN, 10) || 50))
                onSelectFirstN(n)
              }}
            >
              选择前 N 个
            </button>
          </>
        ) : null}
      </div>
      <div className="mm-caption">
        已选 {selectedCount} / 筛选 {total}
      </div>
    </div>
  )
}
