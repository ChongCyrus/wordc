import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Word } from '../../core'
import { parseMeaningString } from '../../data'
import {
  addWord,
  deleteWord,
  getWordsPage,
  updateWord,
} from '../../data'
import { useDeck, useDeckProgress } from '../../app/hooks/useDecks'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { SectionBand } from '../components/SectionBand'
import { Button, IconButton } from '../components/Buttons'
import { Dialog, ConfirmDialog } from '../components/Dialog'
import { Sheet } from '../components/Sheet'
import { SegmentedControl } from '../components/SegmentedControl'
import { EmptyState } from '../components/EmptyState'
import { PlusIcon, SearchIcon, EditIcon, TrashIcon } from '../components/icons'

type Filter = 'all' | 'new' | 'studied'
const PAGE_SIZE = 100

interface WordFormState {
  headword: string
  meaning: string
  phoneticUk: string
  phoneticUs: string
  example: string
  exampleTranslation: string
}

const EMPTY_FORM: WordFormState = {
  headword: '',
  meaning: '',
  phoneticUk: '',
  phoneticUs: '',
  example: '',
  exampleTranslation: '',
}

function wordToForm(word: Word): WordFormState {
  return {
    headword: word.headword,
    meaning: word.meanings.map((meaning) => `${meaning.pos ? `${meaning.pos} ` : ''}${meaning.cn}`).join('\n'),
    phoneticUk: word.phonetic?.uk ?? '',
    phoneticUs: word.phonetic?.us ?? '',
    example: word.examples[0]?.en ?? '',
    exampleTranslation: word.examples[0]?.cn ?? '',
  }
}

function formToInput(form: WordFormState) {
  const meanings = parseMeaningString(form.meaning)
  const phonetic: { uk?: string; us?: string } = {}
  if (form.phoneticUk.trim()) phonetic.uk = form.phoneticUk.trim()
  if (form.phoneticUs.trim()) phonetic.us = form.phoneticUs.trim()
  const input: Parameters<typeof addWord>[1] = {
    headword: form.headword.trim(),
    meanings,
    phonetic: Object.keys(phonetic).length > 0 ? phonetic : undefined,
  }
  if (form.example.trim()) {
    input.examples = [
      {
        en: form.example.trim(),
        ...(form.exampleTranslation.trim() ? { cn: form.exampleTranslation.trim() } : {}),
      },
    ]
  }
  return input
}

/**
 * 词库详情（SPEC §8.3 / 03-ui §4.5）：
 * 统计条 + 全部/已学/未学分段 + 搜索 + 分页列表（加载更多）+ 单词详情弹层 + 增删改。
 */
export default function DeckDetailPage() {
  const { deckId = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { deck, loading: deckLoading } = useDeck(deckId)
  const { progress } = useDeckProgress(deckId)

  const [filter, setFilter] = useState<Filter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)

  const [detailWord, setDetailWord] = useState<Word | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingWord, setEditingWord] = useState<Word | null>(null)
  const [form, setForm] = useState<WordFormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Word | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const page = useLiveQuery(
    () =>
      deckId
        ? getWordsPage(deckId, {
            offset: 0,
            limit,
            filter,
            ...(search.trim() ? { search: search.trim() } : {}),
          })
        : Promise.resolve(null),
    [deckId, filter, search, limit],
  )

  // 搜索防抖 300ms
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  // 条件变化时重置分页
  useEffect(() => {
    setLimit(PAGE_SIZE)
  }, [filter, search])

  // 触底加载更多
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver((entries) => {
      const reachedEnd = page != null && page.words.length < page.total
      if (reachedEnd && entries.some((entry) => entry.isIntersecting)) {
        setLimit((current) => current + PAGE_SIZE)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [page])

  const words = page?.words ?? []
  const canLoadMore = page != null && words.length < page.total

  const openAdd = useCallback(() => {
    setEditingWord(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }, [])

  const openEdit = useCallback((word: Word) => {
    setDetailWord(null)
    setEditingWord(word)
    setForm(wordToForm(word))
    setFormOpen(true)
  }, [])

  const handleSave = async () => {
    if (!deckId) return
    if (!form.headword.trim()) {
      toast.error('请输入英文单词')
      return
    }
    if (parseMeaningString(form.meaning).length === 0) {
      toast.error('请至少填写一条中文释义')
      return
    }
    setSaving(true)
    try {
      if (editingWord) {
        await updateWord(editingWord.id, formToInput(form))
        toast.success('已保存修改')
      } else {
        await addWord(deckId, formToInput(form))
        toast.success('已添加单词')
      }
      setFormOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteWord(deleteTarget.id)
      setDeleteTarget(null)
      setDetailWord(null)
      toast.success('已删除单词')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  if (deckLoading) {
    return (
      <PageShell title="词库" backTo="/decks">
        <div className="mm-loading">正在加载词库…</div>
      </PageShell>
    )
  }

  if (!deck) {
    return (
      <PageShell title="词库" backTo="/decks">
        <EmptyState
          title="词库不存在"
          description="该词库可能已被删除。"
          action={
            <Button variant="primary" onClick={() => navigate('/decks')}>
              回词库列表
            </Button>
          }
        />
      </PageShell>
    )
  }

  return (
    <PageShell
      title={deck.name}
      backTo="/decks"
      actions={
        <IconButton label="添加单词" onClick={openAdd}>
          <PlusIcon size={22} />
        </IconButton>
      }
    >
      <div className="mm-card mm-card--flat" style={{ padding: 14, gap: 12 }}>
        <div className="mm-kpi-row" style={{ gap: 16 }}>
          <div className="mm-kpi">
            <span className="mm-kpi-value">{progress?.wordCount ?? deck.wordCount}</span>
            <span className="mm-kpi-label">全部</span>
          </div>
          <div className="mm-kpi">
            <span className="mm-kpi-value mm-kpi-value--primary">{progress?.studiedCount ?? 0}</span>
            <span className="mm-kpi-label">已学</span>
          </div>
          <div className="mm-kpi">
            <span className="mm-kpi-value">{progress?.newCount ?? 0}</span>
            <span className="mm-kpi-label">未学</span>
          </div>
          <div className="mm-kpi" style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>
            <span className="mm-kpi-value">{Math.round((progress?.progress ?? 0) * 100)}%</span>
            <span className="mm-kpi-label">进度</span>
          </div>
        </div>
        <div className="mm-progress mm-progress--thin">
          <div
            className="mm-progress-fill"
            style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }}
          />
        </div>
      </div>

      <div style={{ padding: '12px 0 8px' }}>
        <SegmentedControl<Filter>
          block
          ariaLabel="筛选单词"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'studied', label: '已学' },
            { value: 'new', label: '未学' },
          ]}
        />
      </div>

      <label className="mm-search">
        <SearchIcon size={18} />
        <input
          value={searchInput}
          placeholder="搜索英文 / 中文释义"
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </label>

      {page == null ? <div className="mm-loading">正在加载单词…</div> : null}

      {page && page.total === 0 ? (
        <EmptyState
          title={search.trim() ? '没有匹配的单词' : '词库还没有单词'}
          description={search.trim() ? '换个关键词试试。' : '点右上角 ＋ 添加第一个单词，或从词库页导入。'}
          action={
            !search.trim() ? (
              <Button variant="primary" onClick={openAdd}>
                添加单词
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {words.length > 0 ? (
        <>
          <SectionBand title={`${page?.total ?? 0} 个单词`} />
          <div className="mm-list">
            {words.map((word) => (
              <button
                key={word.id}
                type="button"
                className="mm-row"
                onClick={() => setDetailWord(word)}
              >
                <span className="mm-row-main">
                  <span className="mm-row-title">{word.headword}</span>
                  <span className="mm-row-sub">
                    {word.meanings
                      .map((meaning) => `${meaning.pos ? `${meaning.pos} ` : ''}${meaning.cn}`)
                      .join('；')}
                  </span>
                </span>
                <span className="mm-chevron">›</span>
              </button>
            ))}
          </div>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {canLoadMore ? (
            <div className="mm-caption" style={{ textAlign: 'center', padding: '12px 0' }}>
              上滑加载更多（已显示 {words.length} / {page?.total ?? 0}）
            </div>
          ) : null}
        </>
      ) : null}

      {/* 单词详情弹层 */}
      <Sheet open={detailWord != null} title={detailWord?.headword ?? ''} onClose={() => setDetailWord(null)}>
        {detailWord ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 8 }}>
            {detailWord.phonetic?.us || detailWord.phonetic?.uk ? (
              <div className="mm-caption">
                {detailWord.phonetic.us ?? detailWord.phonetic.uk}
              </div>
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {detailWord.meanings.map((meaning) => (
                <div key={meaning.id} style={{ fontSize: 'var(--mm-text-title)' }}>
                  {meaning.pos ? <span className="mm-muted">{meaning.pos} </span> : null}
                  {meaning.cn}
                </div>
              ))}
            </div>
            {detailWord.examples.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="mm-caption">例句</span>
                {detailWord.examples.map((example, index) => (
                  <div key={`${example.en}-${index}`}>
                    <div style={{ fontSize: 'var(--mm-text-body-sm)' }}>{example.en}</div>
                    {example.cn ? <div className="mm-row-sub">{example.cn}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {detailWord.mnemonics.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="mm-caption">助记</span>
                {detailWord.mnemonics.map((mnemonic, index) => (
                  <div key={`${mnemonic.text}-${index}`} style={{ fontSize: 'var(--mm-text-body-sm)' }}>
                    <span className="mm-badge mm-badge--muted">{mnemonic.type}</span> {mnemonic.text}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mm-btn-row" style={{ marginTop: 4 }}>
              <Button variant="soft" icon={<EditIcon size={18} />} onClick={() => openEdit(detailWord)}>
                编辑
              </Button>
              <Button
                variant="danger"
                icon={<TrashIcon size={18} />}
                onClick={() => {
                  setDeleteTarget(detailWord)
                  setDetailWord(null)
                }}
              >
                删除
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>

      {/* 新增/编辑单词 */}
      <Dialog
        open={formOpen}
        title={editingWord ? '编辑单词' : '添加单词'}
        onClose={() => setFormOpen(false)}
        dismissable={!saving}
        actions={
          <>
            <Button onClick={() => setFormOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <label className="mm-field">
          <span className="mm-field-label">英文单词</span>
          <input
            className="mm-input"
            value={form.headword}
            disabled={editingWord != null}
            placeholder="如 abandon"
            onChange={(event) => setForm({ ...form, headword: event.target.value })}
          />
        </label>
        <label className="mm-field">
          <span className="mm-field-label">中文释义（每行一条，行首可带词性，如 `vt. 放弃`）</span>
          <textarea
            className="mm-input"
            rows={3}
            value={form.meaning}
            placeholder={'vt. 放弃；抛弃\nn. 放纵'}
            onChange={(event) => setForm({ ...form, meaning: event.target.value })}
          />
        </label>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="mm-field" style={{ flex: 1 }}>
            <span className="mm-field-label">英式音标（可空）</span>
            <input
              className="mm-input"
              value={form.phoneticUk}
              placeholder="[əˈbændən]"
              onChange={(event) => setForm({ ...form, phoneticUk: event.target.value })}
            />
          </label>
          <label className="mm-field" style={{ flex: 1 }}>
            <span className="mm-field-label">美式音标（可空）</span>
            <input
              className="mm-input"
              value={form.phoneticUs}
              placeholder="[əˈbændən]"
              onChange={(event) => setForm({ ...form, phoneticUs: event.target.value })}
            />
          </label>
        </div>
        <label className="mm-field">
          <span className="mm-field-label">例句（英文，可空）</span>
          <input
            className="mm-input"
            value={form.example}
            onChange={(event) => setForm({ ...form, example: event.target.value })}
          />
        </label>
        <label className="mm-field">
          <span className="mm-field-label">例句中文翻译（可空）</span>
          <input
            className="mm-input"
            value={form.exampleTranslation}
            onChange={(event) => setForm({ ...form, exampleTranslation: event.target.value })}
          />
        </label>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget != null}
        title="删除单词？"
        body={deleteTarget ? `将删除「${deleteTarget.headword}」及其学习状态，无法恢复。` : ''}
        confirmLabel="删除"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      />
    </PageShell>
  )
}
