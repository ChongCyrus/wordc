import { useEffect, useState } from 'react'
import {
  deleteRootEtymology,
  generateRootEtymology,
  getRootEtymology,
  getWord,
  getEffectiveContent,
  toRootEtymologyPromptSource,
  loadAiConfig,
  saveRootEtymology,
  validateRootEtymologyDraft,
} from '../../../data'
type RootEtymologyPart = {
  type: 'prefix' | 'root' | 'suffix' | 'other'
  text: string
  meaning: string
  note?: string
}
import { useToast } from '../../../app/toast'
import { Dialog } from '../../components/Dialog'

const TYPE_LABEL: Record<RootEtymologyPart['type'], string> = {
  prefix: '前缀',
  root: '词根',
  suffix: '后缀',
  other: '其他',
}

export function RootEtymologyEditDialog({
  open,
  wordId,
  headword,
  onClose,
  onChanged,
}: {
  open: boolean
  wordId: string
  headword: string
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const [parts, setParts] = useState<RootEtymologyPart[]>([])
  const [etymology, setEtymology] = useState('')
  const [composition, setComposition] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void getRootEtymology(wordId).then((row) => {
      setParts(row?.parts ?? [])
      setEtymology(row?.etymology ?? '')
      setComposition(row?.composition ?? '')
    })
  }, [open, wordId])

  const save = async () => {
    setBusy(true)
    try {
      const draft = validateRootEtymologyDraft({ parts, etymology, composition })
      await saveRootEtymology(wordId, draft, { source: 'manual' })
      toast.success('词根词缀词源已保存')
      onChanged()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const generate = async () => {
    setBusy(true)
    try {
      const config = await loadAiConfig()
      if (!config.apiKey) throw new Error('未配置 AI Key')
      const [word, effective] = await Promise.all([
        getWord(wordId),
        getEffectiveContent(wordId).catch(() => null),
      ])
      if (!word) throw new Error('单词不存在')
      const result = await generateRootEtymology(
        toRootEtymologyPromptSource(
          { ...word, id: word.id, meanings: word.meanings },
          effective?.coreSenses ?? [],
        ),
        config,
      )
      setParts((result.draft.parts ?? []) as RootEtymologyPart[])
      setEtymology(result.draft.etymology ?? '')
      setComposition(result.draft.composition ?? '')
      toast.success('已生成预览，确认后保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'AI 生成失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await deleteRootEtymology(wordId)
      toast.success('已删除词根词缀词源')
      onChanged()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      title={`编辑词根词缀词源 · ${headword}`}
      onClose={onClose}
      dismissable={!busy}
      overlayClassName="mm-mask--above-rating-edit"
      testId="root-etymology-edit-dialog"
      actions={
        <>
          <button type="button" className="mm-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="mm-btn" disabled={busy} onClick={() => void generate()}>
            AI 生成
          </button>
          <button type="button" className="mm-btn mm-btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? '处理中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="root-etymology-form">
        <div className="mm-caption">组成部分（前缀/词根/后缀 + 文本 + 含义）</div>
        {parts.map((part, index) => (
          <div className="root-etymology-part-card" key={`${part.type}-${index}`}>
            <div className="root-etymology-part-row">
              <label className="root-etymology-field">
                <span>部分类型</span>
                <select
                  className="mm-input"
                  aria-label="部分类型"
                  value={part.type}
                  onChange={(event) =>
                    setParts((prev) =>
                      prev.map((item, i) =>
                        i === index ? { ...item, type: event.target.value as RootEtymologyPart['type'] } : item,
                      ),
                    )
                  }
                >
                  {Object.entries(TYPE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="root-etymology-field">
                <span>文本</span>
                <input
                  className="mm-input"
                  aria-label="部分文本"
                  placeholder="如 ab-"
                  value={part.text}
                  onChange={(event) =>
                    setParts((prev) => prev.map((item, i) => (i === index ? { ...item, text: event.target.value } : item)))
                  }
                />
              </label>
              <label className="root-etymology-field">
                <span>含义（必填）</span>
                <input
                  className="mm-input"
                  aria-label="部分含义"
                  placeholder="如 离开"
                  value={part.meaning}
                  onChange={(event) =>
                    setParts((prev) => prev.map((item, i) => (i === index ? { ...item, meaning: event.target.value } : item)))
                  }
                />
              </label>
            </div>
            <button type="button" className="mm-btn mm-btn--sm" onClick={() => setParts((prev) => prev.filter((_, i) => i !== index))}>
              删除该部分
            </button>
          </div>
        ))}
        <button
          type="button"
          className="mm-btn mm-btn--sm"
          onClick={() => setParts((prev) => [...prev, { type: 'root', text: '', meaning: '' }])}
        >
          + 添加部分
        </button>
        <label className="root-etymology-field"><span>词源说明</span>
        <textarea className="mm-input" rows={2} value={etymology} onChange={(event) => setEtymology(event.target.value)} /></label>
        <label className="root-etymology-field"><span>组合说明</span>
        <textarea className="mm-input" rows={2} value={composition} onChange={(event) => setComposition(event.target.value)} /></label>
        <button type="button" className="mm-btn mm-btn--danger mm-btn--sm" disabled={busy} onClick={() => void remove()}>
          删除词源数据
        </button>
      </div>
    </Dialog>
  )
}
