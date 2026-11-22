import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  deleteFilterSet,
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
  unit: ['eq', 'contains'],
  selected: ['eq'],
  rare: ['eq'],
  etymology: ['eq'],
  familiarity: ['gte', 'lte'],
  due: ['gte', 'lte'],
  headword: ['contains'],
}
const EMPTY_CONDITION: FilterCondition = { field: 'learned', op: 'eq', value: true }
const EMPTY_GROUP: FilterGroup = { match: 'or', conditions: [EMPTY_CONDITION] }
const EMPTY_FILTER: AdvancedFilter = { match: 'and', groups: [EMPTY_GROUP] }

function valueFor(field: FilterField, raw: string): FilterCondition['value'] {
  if (field === 'learned' || field === 'today' || field === 'selected') return raw === 'true'
  if (field === 'familiarity' || field === 'due') return Number(raw)
  return raw
}

function fieldValueText(field: FilterField, condition: FilterCondition): string {
  if (field === 'learned' || field === 'today' || field === 'selected') return String(condition.value === true)
  return String(condition.value ?? '')
}

export default function AdvancedFilterPage() {
  const { deckId = '' } = useParams()
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

  useEffect(() => {
    void listSavedFilterSets().then(setSets).catch(() => undefined)
  }, [])

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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '筛选失败')
    } finally {
      setLoading(false)
    }
  }

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  const allIds = result?.words.map((item) => item.word.id) ?? []

  const applySet = (set: SavedFilterSet) => {
    setFilter(set.filter)
    toast.success(`已载入索引集「${set.name}」`)
  }

  const save = async () => {
    try {
      const saved = await saveFilterSet({ name: saveName, filter, deckId })
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
                {condition.field === 'learned' || condition.field === 'today' || condition.field === 'selected' ? (
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
      <div className="mm-btn-row">
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
      <div className="mm-btn-row">
        <button type="button" className="mm-btn mm-btn--primary" disabled={loading} onClick={() => void run()}>
          {loading ? '筛选中…' : '执行筛选'}
        </button>
        <button type="button" className="mm-btn" onClick={() => setSaveOpen(true)}>保存索引集</button>
        <button type="button" className="mm-btn" onClick={() => setSelected(allIds)}>全选</button>
        <button type="button" className="mm-btn" onClick={() => setSelected(allIds.filter((id) => !selected.includes(id)))}>反选</button>
        <button type="button" className="mm-btn" onClick={() => setSelected([])}>取消全选</button>
      </div>
      <div className="mm-caption">已选 {selected.length} / 筛选 {result?.total ?? 0}</div>
      {sets.length > 0 ? (
        <div className="mm-list">
          {sets.map((set) => (
            <div className="mm-row" key={set.id}>
              <span className="mm-row-main"><span className="mm-row-title">{set.name}</span></span>
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
        <input className="mm-input" aria-label="索引集名称" placeholder="名称" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
      </Dialog>
    </PageShell>
  )
}
