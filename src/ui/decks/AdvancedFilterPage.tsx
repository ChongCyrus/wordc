import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  deleteFilterSet,
  getDeckChapters,
  listSavedFilterSets,
  queryAdvancedFilter,
  renameFilterSet,
  saveFilterSet,
} from '../../data'
import type {
  AdvancedFilter,
  AdvancedFilterItem,
  FilterCondition,
  FilterField,
  FilterGroup,
  FilterGroupMatch,
  FilterOperator,
  SavedFilterSet,
} from '../../data'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { Dialog } from '../components/Dialog'
import { EmptyState } from '../components/EmptyState'

const FIELD_LABEL: Record<FilterField, string> = {
  learned: '已学',
  today: '今日计划',
  unit: '单元',
  selected: '已选',
  rare: '不常考状态',
  etymology: '词根词源状态',
  familiarity: '不熟悉度',
  due: '到期时间',
  headword: '英文/中文',
}
const OP_LABEL: Record<FilterOperator, string> = {
  eq: '等于',
  neq: '不等于',
  gte: '≥',
  lte: '≤',
  between: '介于',
  in: '包含于',
  contains: '包含',
}
const FIELD_OPS: Record<FilterField, FilterOperator[]> = {
  learned: ['eq'],
  today: ['eq'],
  unit: ['in', 'eq', 'contains'],
  selected: ['eq'],
  rare: ['in', 'eq'],
  etymology: ['in', 'eq'],
  familiarity: ['gte', 'lte'],
  due: ['gte', 'lte'],
  headword: ['contains'],
}
const EMPTY_CONDITION: FilterCondition = { field: 'learned', op: 'eq', value: true }
const EMPTY_GROUP: FilterGroup = { match: 'or', conditions: [EMPTY_CONDITION] }
const EMPTY_FILTER: AdvancedFilter = { match: 'and', groups: [EMPTY_GROUP] }
const MULTI_VALUE_OPTIONS: Partial<Record<FilterField, Array<{ value: string; label: string }>>> = {
  rare: [
    { value: 'unchecked', label: '未检查' },
    { value: 'unmarked', label: '未标记' },
    { value: 'marked', label: '已标记' },
  ],
  etymology: [
    { value: 'unchecked', label: '未检查' },
    { value: 'none', label: '无词源' },
    { value: 'ai', label: 'AI 词源' },
    { value: 'manual', label: '手改词源' },
  ],
}

function asValueArray(value: FilterCondition['value']): string[] {
  return Array.isArray(value) ? value.map(String) : value == null || value === '' ? [] : [String(value)]
}

function valueFor(field: FilterField, raw: string): FilterCondition['value'] {
  if (field === 'learned' || field === 'today' || field === 'selected') return raw === 'true'
  if (field === 'familiarity' || field === 'due') return Number(raw)
  return raw
}

function fieldValueText(field: FilterField, condition: FilterCondition): string {
  if (field === 'learned' || field === 'today' || field === 'selected') return String(condition.value === true)
  return String(condition.value ?? '')
}

function conditionSummary(condition: FilterCondition): string {
  const label = FIELD_LABEL[condition.field]
  const op = OP_LABEL[condition.op]
  if (Array.isArray(condition.value)) return `${label} ${op} ${condition.value.map(String).join('/') || '未选'}`
  if (condition.field === 'learned' || condition.field === 'today' || condition.field === 'selected') {
    return `${label} ${condition.value === true ? '是' : '否'}`
  }
  return `${label} ${op} ${String(condition.value ?? '')}`
}

function FilterTreeEditor({
  filter,
  onChange,
  unitOptions,
  hitCounts,
}: {
  filter: AdvancedFilter
  onChange: (next: AdvancedFilter) => void
  unitOptions: Array<{ value: string; label: string }>
  hitCounts: Record<number, number>
}) {
  const [rootOpen, setRootOpen] = useState(() => {
    try {
      return window.localStorage.getItem('momo:filterTree:root') !== '0'
    } catch {
      return true
    }
  })
  const [openGroups, setOpenGroups] = useState<Record<number, boolean>>(() => {
    try {
      const saved = window.localStorage.getItem('momo:filterTree:groups')
      return saved ? (JSON.parse(saved) as Record<number, boolean>) : { 0: true }
    } catch {
      return { 0: true }
    }
  })
  const [editCondition, setEditCondition] = useState<{ gi: number; ci: number } | null>(null)

  const persistRoot = (next: boolean) => {
    setRootOpen(next)
    try {
      window.localStorage.setItem('momo:filterTree:root', next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  const toggleGroup = (gi: number) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [gi]: !prev[gi] }
      try {
        window.localStorage.setItem('momo:filterTree:groups', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const updateGroup = (gi: number, patch: Partial<FilterGroup>) =>
    onChange({ ...filter, groups: filter.groups.map((group, index) => (index === gi ? { ...group, ...patch } : group)) })
  const updateCondition = (gi: number, ci: number, patch: Partial<FilterCondition>) =>
    updateGroup(gi, {
      conditions: filter.groups[gi]!.conditions.map((condition, index) => (index === ci ? { ...condition, ...patch } : condition)),
    })

  const editing =
    editCondition && filter.groups[editCondition.gi]?.conditions[editCondition.ci]
      ? {
          gi: editCondition.gi,
          ci: editCondition.ci,
          group: filter.groups[editCondition.gi]!,
          condition: filter.groups[editCondition.gi]!.conditions[editCondition.ci]!,
        }
      : null

  return (
    <div className="filter-tree">
      <div className="filter-tree-root-card">
        <button type="button" className="filter-tree-arrow" aria-label={rootOpen ? '收起根节点' : '展开根节点'} onClick={() => persistRoot(!rootOpen)}>
          {rootOpen ? '▾' : '▸'}
        </button>
        <span className="filter-tree-root-title">筛选</span>
        <select
          className="mm-input filter-tree-root-match"
          aria-label="组间逻辑"
          value={filter.match}
          onChange={(event) => onChange({ ...filter, match: event.target.value as FilterGroupMatch })}
        >
          <option value="and">组间 AND</option>
          <option value="or">组间 OR</option>
        </select>
      </div>
      {rootOpen ? (
        <div className="filter-tree-children">
          {filter.groups.map((group, gi) => (
            <div className="filter-tree-node" key={gi}>
              <div className="filter-tree-group-card">
                <button type="button" className="filter-tree-arrow" aria-label={openGroups[gi] ? `收起组 ${gi + 1}` : `展开组 ${gi + 1}`} onClick={() => toggleGroup(gi)}>
                  {openGroups[gi] ? '▾' : '▸'}
                </button>
                <span className="filter-tree-group-title">组 {gi + 1}</span>
                <select
                  className="mm-input filter-tree-group-match"
                  aria-label={`组 ${gi + 1} 组内逻辑`}
                  value={group.match}
                  onChange={(event) => updateGroup(gi, { match: event.target.value as FilterGroupMatch })}
                  onClick={(event) => event.stopPropagation()}
                >
                  <option value="or">组内 OR</option>
                  <option value="and">组内 AND</option>
                </select>
                <span className="mm-caption">条件 {group.conditions.length} · 命中 {hitCounts[gi] ?? '—'}</span>
                <button
                  type="button"
                  className="mm-btn mm-btn--sm filter-tree-delete-group"
                  onClick={() => onChange({ ...filter, groups: filter.groups.filter((_, index) => index !== gi) })}
                >
                  删除组
                </button>
              </div>
              {openGroups[gi] ? (
                <div className="filter-tree-children">
                  {group.conditions.map((condition, ci) => (
                    <div className="filter-tree-leaf" key={ci}>
                      <button type="button" className="filter-tree-leaf-main" onClick={() => setEditCondition({ gi, ci })}>
                        条件 {ci + 1}：{conditionSummary(condition)}
                      </button>
                      <button
                        type="button"
                        className="mm-btn mm-btn--sm filter-tree-delete-cond"
                        aria-label={`删除条件 ${ci + 1}`}
                        onClick={() => updateGroup(gi, { conditions: group.conditions.filter((_, index) => index !== ci) })}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="mm-btn mm-btn--sm filter-tree-add-leaf"
                    onClick={() => updateGroup(gi, { conditions: [...group.conditions, { ...EMPTY_CONDITION }] })}
                  >
                    + 条件
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            className="mm-btn mm-btn--sm filter-tree-add-leaf"
            onClick={() => onChange({ ...filter, groups: [...filter.groups, { ...EMPTY_GROUP, conditions: [{ ...EMPTY_CONDITION }] }] })}
          >
            + 属性组
          </button>
        </div>
      ) : null}
      <Dialog
        open={editCondition != null}
        title={editCondition ? `编辑条件 ${editCondition.ci + 1}（组 ${editCondition.gi + 1}）` : '编辑条件'}
        onClose={() => setEditCondition(null)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setEditCondition(null)}>关闭</button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => setEditCondition(null)}
            >
              完成
            </button>
          </>
        }
      >
        {editing ? (
          <div className="filter-tree-sheet">
            <label className="filter-tree-field">
              <span>属性</span>
              <select
                className="mm-input"
                value={editing.condition.field}
                onChange={(event) => {
                  const field = event.target.value as FilterField
                  updateCondition(editing.gi, editing.ci, { field, op: FIELD_OPS[field][0]!, value: undefined })
                }}
              >
                {Object.entries(FIELD_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="filter-tree-field">
              <span>操作符</span>
              <select
                className="mm-input"
                value={editing.condition.op}
                onChange={(event) => updateCondition(editing.gi, editing.ci, { op: event.target.value as FilterOperator })}
              >
                {FIELD_OPS[editing.condition.field].map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </select>
            </label>
            {editing.condition.field === 'unit' || MULTI_VALUE_OPTIONS[editing.condition.field] ? (
              <div className="advanced-filter-chips">
                {(editing.condition.field === 'unit' ? unitOptions : MULTI_VALUE_OPTIONS[editing.condition.field]!).map((option) => {
                  const values = asValueArray(editing.condition.value)
                  const checked = values.includes(option.value)
                  return (
                    <label key={option.value} className={`advanced-filter-chip${checked ? ' is-checked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked ? values.filter((value) => value !== option.value) : [...values, option.value]
                          updateCondition(editing.gi, editing.ci, { op: 'in', value: next })
                        }}
                      />
                      {option.label}
                    </label>
                  )
                })}
              </div>
            ) : editing.condition.field === 'learned' || editing.condition.field === 'today' || editing.condition.field === 'selected' ? (
              <label className="filter-tree-field">
                <span>值</span>
                <select
                  className="mm-input"
                  value={String(editing.condition.value === true)}
                  onChange={(event) => updateCondition(editing.gi, editing.ci, { value: event.target.value === 'true' })}
                >
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              </label>
            ) : (
              <label className="filter-tree-field">
                <span>值</span>
                <input
                  className="mm-input"
                  value={String(editing.condition.value ?? '')}
                  onChange={(event) => updateCondition(editing.gi, editing.ci, { value: valueFor(editing.condition.field, event.target.value) })}
                />
              </label>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}

function FilterGraphEditor({
  filter,
  onChange,
  hitCounts,
}: {
  filter: AdvancedFilter
  onChange: (next: AdvancedFilter) => void
  hitCounts: Record<number, number>
}) {
  const [positions, setPositions] = useState<Record<number, { x: number; y: number }>>({})
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const dragRef = useState<{ index: number; dx: number; dy: number } | null>(null)
  const drag = dragRef[0]
  const setDrag = dragRef[1]
  const positionOf = (index: number) => {
    const raw = positions[index] ?? { x: 18 + (index % 3) * 110, y: 12 + Math.floor(index / 3) * 105 }
    return { x: Math.max(6, Math.min(250, raw.x)), y: Math.max(6, Math.min(200, raw.y)) }
  }
  return (
    <div
      className="filter-graph"
      onPointerMove={(event) => {
        if (!drag) return
        const rect = event.currentTarget.getBoundingClientRect()
        setPositions((prev) => ({ ...prev, [drag.index]: { x: Math.max(6, Math.min(250, event.clientX - rect.left - drag.dx)), y: Math.max(6, Math.min(200, event.clientY - rect.top - drag.dy)) } }))
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
    >
      <svg className="filter-graph-lines" viewBox="0 0 400 300" preserveAspectRatio="none" aria-hidden="true">
        {filter.groups.map((_, gi) => {
          const pos = positionOf(gi)
          return <line key={gi} x1={200} y1={150} x2={pos.x + 46} y2={pos.y + 36} />
        })}
      </svg>
      <div className="filter-graph-center">组间 {filter.match.toUpperCase()}</div>
      {filter.groups.map((group, gi) => {
        const pos = positionOf(gi)
        return (
          <button
            key={gi}
            type="button"
            className="filter-graph-node"
            style={{ left: pos.x, top: pos.y }}
            onPointerDown={(event) => setDrag({ index: gi, dx: event.clientX - (event.currentTarget.getBoundingClientRect().left + 32), dy: event.clientY - (event.currentTarget.getBoundingClientRect().top + 32) })}
            onClick={() => setEditIndex(gi)}
          >
            <span>组 {gi + 1}</span>
            <small>{group.match.toUpperCase()} · {group.conditions.length} 条件</small>
            <small>{hitCounts[gi] ?? '—'} 命中</small>
          </button>
        )
      })}
      <button
        type="button"
        className="mm-btn mm-btn--sm filter-graph-add"
        onClick={() => onChange({ ...filter, groups: [...filter.groups, { ...EMPTY_GROUP, conditions: [{ ...EMPTY_CONDITION }] }] })}
      >
        + 属性组
      </button>
      <div className="mm-caption filter-graph-hint">
        拖拽圆节点调整位置；点击圆打开该组条件编辑；条件在「列表」视图精确编辑
      </div>
      <Dialog
        open={editIndex != null}
        title={editIndex != null ? `组 ${editIndex + 1} 条件` : '组条件'}
        onClose={() => setEditIndex(null)}
        actions={
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setEditIndex(null)}>关闭</button>
        }
      >
        {editIndex != null ? (
          <div className="mm-list">
            <label className="mm-row">
              <span className="mm-row-title">组内逻辑</span>
              <select
                className="mm-input"
                aria-label="图谱组内逻辑"
                value={filter.groups[editIndex]?.match ?? 'or'}
                onChange={(event) => onChange({ ...filter, groups: filter.groups.map((item, index) => (index === editIndex ? { ...item, match: event.target.value as FilterGroupMatch } : item)) })}
              >
                <option value="or">OR</option>
                <option value="and">AND</option>
              </select>
            </label>
            {(filter.groups[editIndex]?.conditions ?? []).map((condition, index) => (
              <div className="mm-caption" key={index}>{index + 1}. {conditionSummary(condition)}</div>
            ))}
            <div className="mm-caption">需要精确增删条件请切到「列表」视图。</div>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}

export default function AdvancedFilterPage() {
  const { deckId = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const stashKey = `momo:filterPageStash:${deckId}`
  const toast = useToast()
  const [filter, setFilter] = useState<AdvancedFilter>(EMPTY_FILTER)
  const [groupBy, setGroupBy] = useState<'chapter' | 'learned' | 'rare' | 'etymology'>('chapter')
  const [sort, setSort] = useState<'order' | 'alpha' | 'familiarity' | 'due' | 'chapter'>('order')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [result, setResult] = useState<{ total: number; words: AdvancedFilterItem[]; groups: Array<{ key: string; count: number; wordIds: string[] }> } | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [sets, setSets] = useState<SavedFilterSet[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [view, setViewState] = useState<'tree' | 'graph' | 'list'>(() => {
    try {
      const saved = window.localStorage.getItem('momo:advancedFilter:view')
      return saved === 'graph' || saved === 'list' || saved === 'tree' ? saved : 'tree'
    } catch {
      return 'tree'
    }
  })
  const setView = (next: 'tree' | 'graph' | 'list') => {
    setViewState(next)
    try {
      window.localStorage.setItem('momo:advancedFilter:view', next)
    } catch {
      /* ignore */
    }
  }
  const [hitCounts, setHitCounts] = useState<Record<number, number>>({})
  const [snapshotWordIds, setSnapshotWordIds] = useState<string[] | null>(null)
  const [unitOptions, setUnitOptions] = useState<Array<{ value: string; label: string }>>([])

  // 0.5.1：从生成页/临时复习返回时恢复条件/已选/结果
  useEffect(() => {
    if (searchParams.get('restore') !== '1') return
    let raw: string | null = null
    try {
      raw = window.sessionStorage.getItem(stashKey)
    } catch {
      raw = null
    }
    if (!raw) return
    try {
      const stash = JSON.parse(raw) as {
        filter: AdvancedFilter
        sort: 'order' | 'alpha' | 'familiarity' | 'due' | 'chapter'
        direction: 'asc' | 'desc'
        groupBy: 'chapter' | 'learned' | 'rare' | 'etymology'
        selected: string[]
        resultTotal: number
      }
      setFilter(stash.filter)
      setSort(stash.sort)
      setDirection(stash.direction)
      setGroupBy(stash.groupBy)
      setSelected(stash.selected)
      setLoading(true)
      void queryAdvancedFilter({
        deckId,
        filter: stash.filter,
        groupBy: stash.groupBy,
        sort: stash.sort,
        direction: stash.direction,
        limit: 500,
      })
        .then((next) => {
          setResult({ total: next.total, words: next.words, groups: next.groups })
        })
        .catch(() => undefined)
        .finally(() => setLoading(false))
    } catch {
      /* ignore bad stash */
    } finally {
      try {
        window.sessionStorage.removeItem(stashKey)
      } catch {
        /* ignore */
      }
    }
  }, [deckId, searchParams, stashKey])

  useEffect(() => {
    void listSavedFilterSets().then(setSets).catch(() => undefined)
    void getDeckChapters(deckId)
      .then((chapters) => setUnitOptions(chapters.map((chapter) => ({ value: chapter.chapter, label: chapter.chapter }))))
      .catch(() => setUnitOptions([]))
  }, [deckId])

  const updateGroup = (gi: number, patch: Partial<FilterGroup>) =>
    setFilter((prev) => ({
      ...prev,
      groups: prev.groups.map((group, index) => (index === gi ? { ...group, ...patch } : group)),
    }))

  const updateCondition = (gi: number, ci: number, patch: Partial<FilterCondition>) =>
    setFilter((prev) => ({
      ...prev,
      groups: prev.groups.map((group, index) =>
        index === gi
          ? { ...group, conditions: group.conditions.map((cond, i) => (i === ci ? { ...cond, ...patch } : cond)) }
          : group,
      ),
    }))

  const run = async () => {
    setLoading(true)
    try {
      const next = await queryAdvancedFilter({ deckId, filter, groupBy, sort, direction, limit: 500 })
      setResult({ total: next.total, words: next.words, groups: next.groups })
      setSelected([])
      const hits: Record<number, number> = {}
      await Promise.all(filter.groups.map(async (group, gi) => {
        try {
          const single = await queryAdvancedFilter({ deckId, filter: { ...filter, groups: [group] }, limit: 1 })
          hits[gi] = single.total
        } catch {
          hits[gi] = 0
        }
      }))
      setHitCounts(hits)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '筛选失败')
    } finally {
      setLoading(false)
    }
  }

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  const allIds = result?.words.map((item) => item.word.id) ?? []
  const actionIds = selected.length > 0 ? selected : snapshotWordIds && snapshotWordIds.length > 0 ? snapshotWordIds : allIds

  const applySet = (set: SavedFilterSet) => {
    setFilter(set.filter)
    if (set.sort) setSort(set.sort)
    if (set.direction) setDirection(set.direction)
    if (set.groupBy) setGroupBy(set.groupBy)
    setSnapshotWordIds(Array.isArray(set.wordIds) ? [...set.wordIds] : null)
    toast.success(
      `已载入索引集「${set.name}」（含排序/分组${set.wordIds?.length ? ` + ${set.wordIds.length} 词快照` : ''}）`,
    )
  }

  const save = async () => {
    try {
      const snapshotWordIdsToSave = selected.length > 0 ? selected : allIds
      const saved = await saveFilterSet({
        name: saveName,
        filter,
        deckId,
        sort,
        direction,
        groupBy,
        wordIds: snapshotWordIdsToSave,
      })
      setSets((prev) => [...prev.filter((item) => item.id !== saved.id), saved])
      setSaveOpen(false)
      setSaveName('')
      toast.success('已保存索引集')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  return (
    <PageShell title="高级筛选" backTo={`/decks/${deckId}`}>
      <div className="mm-btn-row">
        {([
          ['tree', '树状'],
          ['graph', '图谱'],
          ['list', '列表'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`mm-btn mm-btn--sm${view === value ? ' mm-btn--primary' : ''}`}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'tree' ? (
        <FilterTreeEditor filter={filter} onChange={setFilter} unitOptions={unitOptions} hitCounts={hitCounts} />
      ) : view === 'graph' ? (
        <FilterGraphEditor filter={filter} onChange={setFilter} hitCounts={hitCounts} />
      ) : (
        <>
      <div className="mm-list">
        <div className="mm-row">
          <span className="mm-row-title">组间关系</span>
          <select className="mm-input" value={filter.match} onChange={(event) => setFilter((prev) => ({ ...prev, match: event.target.value as FilterGroupMatch }))}>
            <option value="and">AND（全部组满足）</option>
            <option value="or">OR（任一组满足）</option>
          </select>
        </div>
        {filter.groups.map((group, gi) => (
          <div className="advanced-filter-group" key={gi}>
            <div className="mm-btn-row">
              <span className="mm-row-title">组 {gi + 1}</span>
              <select className="mm-input" value={group.match} onChange={(event) => updateGroup(gi, { match: event.target.value as FilterGroupMatch })}>
                <option value="or">组内 OR</option>
                <option value="and">组内 AND</option>
              </select>
              <button type="button" className="mm-btn mm-btn--sm" onClick={() => setFilter((prev) => ({ ...prev, groups: prev.groups.filter((_, index) => index !== gi) }))}>
                删除组
              </button>
            </div>
            {group.conditions.map((condition, ci) => (
              <div className="advanced-filter-row" key={ci}>
                <select
                  className="mm-input"
                  aria-label="属性"
                  value={condition.field}
                  onChange={(event) => {
                    const field = event.target.value as FilterField
                    updateCondition(gi, ci, { field, op: FIELD_OPS[field][0], value: undefined })
                  }}
                >
                  {Object.entries(FIELD_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <select
                  className="mm-input"
                  aria-label="操作符"
                  value={condition.op}
                  onChange={(event) => updateCondition(gi, ci, { op: event.target.value as FilterOperator })}
                >
                  {FIELD_OPS[condition.field].map((op) => (
                    <option key={op} value={op}>{OP_LABEL[op]}</option>
                  ))}
                </select>
                {condition.field === 'unit' || MULTI_VALUE_OPTIONS[condition.field] ? (
                  <span className="advanced-filter-chips">
                    {(condition.field === 'unit' ? unitOptions : MULTI_VALUE_OPTIONS[condition.field]!).map((option) => {
                      const values = asValueArray(condition.value)
                      const checked = values.includes(option.value)
                      return (
                        <label key={option.value} className={`advanced-filter-chip${checked ? ' is-checked' : ''}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const next = checked
                                ? values.filter((value) => value !== option.value)
                                : [...values, option.value]
                              updateCondition(gi, ci, { op: 'in', value: next })
                            }}
                          />
                          {option.label}
                        </label>
                      )
                    })}
                  </span>
                ) : condition.field === 'learned' || condition.field === 'today' || condition.field === 'selected' ? (
                  <select
                    className="mm-input"
                    aria-label="值"
                    value={String(condition.value === true)}
                    onChange={(event) => updateCondition(gi, ci, { value: event.target.value === 'true' })}
                  >
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : (
                  <input
                    className="mm-input"
                    aria-label="值"
                    placeholder="值"
                    value={fieldValueText(condition.field, condition)}
                    onChange={(event) => updateCondition(gi, ci, { value: valueFor(condition.field, event.target.value) })}
                  />
                )}
                <button type="button" className="mm-btn mm-btn--sm" onClick={() => updateGroup(gi, { conditions: group.conditions.filter((_, i) => i !== ci) })}>
                  删除
                </button>
              </div>
            ))}
            <button type="button" className="mm-btn mm-btn--sm" onClick={() => updateGroup(gi, { conditions: [...group.conditions, { ...EMPTY_CONDITION }] })}>
              + 条件
            </button>
          </div>
        ))}
        <button type="button" className="mm-btn mm-btn--sm" onClick={() => setFilter((prev) => ({ ...prev, groups: [...prev.groups, { ...EMPTY_GROUP, conditions: [{ ...EMPTY_CONDITION }] }] }))}>
          + 属性组
        </button>
      </div>
        </>
      )}
      <div className="mm-btn-row filter-sort-row">
        <select className="mm-input" value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}>
          <option value="chapter">按单元分组</option>
          <option value="learned">按已学分组</option>
          <option value="rare">按不常考分组</option>
          <option value="etymology">按词源状态分组</option>
        </select>
        <select className="mm-input" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
          <option value="order">词库顺序</option>
          <option value="alpha">字母 A-Z</option>
          <option value="familiarity">不熟悉度</option>
          <option value="due">到期时间</option>
          <option value="chapter">单元</option>
        </select>
        <select className="mm-input" value={direction} onChange={(event) => setDirection(event.target.value as 'asc' | 'desc')}>
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
      </div>
      <div className="mm-btn-row filter-actions">
        <button type="button" className="mm-btn mm-btn--primary filter-actions-primary" disabled={loading} onClick={() => void run()}>
          {loading ? '筛选中…' : '执行筛选'}
        </button>
        <button type="button" className="mm-btn" onClick={() => setSaveOpen(true)}>保存索引集</button>
        <button type="button" className="mm-btn" onClick={() => setSelected(allIds)}>全选</button>
        <button type="button" className="mm-btn" onClick={() => setSelected(allIds.filter((id) => !selected.includes(id)))}>反选</button>
        <button type="button" className="mm-btn" onClick={() => setSelected([])}>取消全选</button>
      </div>
      <div className="mm-caption">已选 {selected.length} / 筛选 {result?.total ?? 0}</div>
      {result && result.total > 0 ? (
        <div className="filter-bottom-bar">
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            onClick={() => {
              const wordIds = actionIds
              const sourceLabel = `高级筛选 ${wordIds.length} 词${snapshotWordIds?.length ? '（索引集快照）' : ''}`
              try {
                window.sessionStorage.setItem(
                  stashKey,
                  JSON.stringify({ filter, sort, direction, groupBy, selected, resultTotal: result?.total ?? 0 }),
                )
                window.sessionStorage.setItem(
                  'momo:filterGenerateSeed',
                  JSON.stringify({ deckId, wordIds, sourceLabel }),
                )
              } catch {
                toast.error('无法保存生成种子')
                return
              }
              navigate(`/decks/${encodeURIComponent(deckId)}/generate`)
            }}
          >
            AI 生成数据（{actionIds.length}）
          </button>
          <button
            type="button"
            className="mm-btn"
            onClick={() => {
              const wordIds = actionIds
              try {
                window.sessionStorage.setItem(
                  stashKey,
                  JSON.stringify({ filter, sort, direction, groupBy, selected, resultTotal: result?.total ?? 0 }),
                )
              } catch {
                /* ignore */
              }
              navigate(`/temp-review?words=${encodeURIComponent(wordIds.join(','))}&returnTo=${encodeURIComponent(`/decks/${deckId}/filter?restore=1`)}`)
            }}
          >
            临时复习（{actionIds.length}）
          </button>
          <button type="button" className="mm-btn" onClick={() => setSaveOpen(true)}>保存索引集</button>
        </div>
      ) : null}
      {sets.length > 0 ? (
        <div className="mm-list">
          {sets.map((set) => (
            <div className="mm-card saved-filter-card" key={set.id}>
              <div className="mm-row-title">{set.name}</div>
              <div className="mm-caption">{set.wordIds?.length ? `${set.wordIds.length} 词快照` : '无快照（载入后重跑筛选）'}</div>
              <div className="saved-filter-actions">
                <button type="button" className="mm-btn mm-btn--sm" onClick={() => applySet(set)}>载入</button>
                <button
                  type="button"
                  className="mm-btn mm-btn--sm"
                  onClick={() => {
                    const name = window.prompt('索引集新名称', set.name)
                    if (!name || name.trim() === set.name) return
                    void renameFilterSet(set.id, name)
                      .then(() => setSets((prev) => prev.map((item) => (item.id === set.id ? { ...item, name: name.trim() } : item))))
                      .catch((error) => toast.error(error instanceof Error ? error.message : '重命名失败'))
                  }}
                >
                  重命名
                </button>
                <button type="button" className="mm-btn mm-btn--sm" onClick={() => void deleteFilterSet(set.id).then(() => setSets((prev) => prev.filter((item) => item.id !== set.id)))}>删除</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {result && result.words.length === 0 ? <EmptyState title="没有匹配的词" description="调整筛选条件再试。" /> : null}
      {result && result.groups.length > 0 ? (
        <div className="mm-list">
          {result.groups.map((group) => (
            <div className="mm-row" key={group.key}>
              <span className="mm-row-main"><span className="mm-row-title">{group.key}</span><span className="mm-row-sub">{group.count} 词</span></span>
              <button type="button" className="mm-btn mm-btn--sm" onClick={() => setSelected(group.wordIds)}>选择本组</button>
            </div>
          ))}
        </div>
      ) : null}
      {result && result.words.length > 0 ? (
        <div className="mm-list">
          {result.words.map((item) => (
            <label className="mm-row" key={item.word.id}>
              <span className="mm-row-main">
                <span className="mm-row-title">{item.word.headword}</span>
                <span className="mm-row-sub">{item.word.meanings.map((m) => m.cn).slice(0, 2).join('；')}</span>
              </span>
              <input type="checkbox" checked={selected.includes(item.word.id)} onChange={() => toggle(item.word.id)} />
            </label>
          ))}
        </div>
      ) : null}
      <Dialog
        open={saveOpen}
        title="保存索引集"
        onClose={() => setSaveOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setSaveOpen(false)}>取消</button>
            <button type="button" className="mm-btn mm-btn--primary" onClick={() => void save()}>保存</button>
          </>
        }
      >
        <div className="mm-caption" style={{ marginBottom: 8 }}>
          会保存当前 {selected.length > 0 ? selected.length : result?.total ?? 0} 个词的快照（以及条件/排序/分组）。
        </div>
        <input className="mm-input" aria-label="索引集名称" placeholder="名称" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
      </Dialog>
    </PageShell>
  )
}
