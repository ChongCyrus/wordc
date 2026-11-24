import { useEffect, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { aiErrorMessage } from '../../../app/hooks/aiUi'
import {
  clearCoreSenseOverview,
  generateCoreSenseOverview,
  getEffectiveContent,
  getWord,
  loadAiConfig,
  saveCoreSenseOverview,
} from '../../../data'
import { MultilineTextarea } from '../../components/MultilineTextarea'

/** task-237：注释面本义串联记忆段落点击编辑；层级同 SenseMnemonicEditDialog */
export function CoreSenseOverviewEditDialog({
  open,
  wordId,
  word,
  initialText,
  onClose,
  onChanged,
}: {
  open: boolean
  wordId: string
  word: string
  initialText: string
  onClose: () => void
  onChanged?: () => void
}) {
  const [text, setText] = useState(initialText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setText(initialText)
    setBusy(false)
    setError(null)
  }, [open, initialText])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveCoreSenseOverview(wordId, { text: text.trim(), source: 'manual' })
      onChanged?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    setBusy(true)
    setError(null)
    try {
      const config = await loadAiConfig()
      if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
      const [effective, wordRow] = await Promise.all([
        getEffectiveContent(wordId),
        getWord(wordId),
      ])
      const source = {
        word,
        coreSenses: (effective?.coreSenses ?? [])
          .filter((sense) => Boolean(sense.label))
          .map((sense) => ({
            index: sense.index,
            label: sense.label,
            ...(sense.note ? { note: sense.note } : {}),
            ...(sense.origin ? { origin: sense.origin } : {}),
          })),
        mappedMeanings: (effective?.meaningMap ?? []).map((mapping) => ({
          coreSenseIndex: mapping.coreSenseIndex,
          meaningIndex: mapping.meaningIndex,
          cn: wordRow?.meanings?.[mapping.meaningIndex - 1]?.cn ?? '',
        })),
      }
      if (source.coreSenses.length === 0) throw new Error('该词暂无本义数据')
      const result = await generateCoreSenseOverview(source, config)
      setText(result.text)
    } catch (err) {
      setError(aiErrorMessage((err as { code?: string })?.code, '生成失败'))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setError(null)
    try {
      await clearCoreSenseOverview(wordId)
      onChanged?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      title={`编辑本义串联记忆 · ${word}`}
      overlayClassName="mm-mask--above-rating-edit"
      testId="core-overview-edit-dialog"
      dismissable={!busy}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="mm-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            disabled={busy || !text.trim()}
            onClick={() => void save()}
          >
            保存
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <MultilineTextarea
          className="mm-input"
          aria-label="本义串联记忆内容"
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="mm-btn-row">
          <button type="button" className="mm-btn" disabled={busy} onClick={() => void regenerate()}>
            AI 重新生成
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--danger"
            disabled={busy || !text.trim()}
            onClick={() => void clear()}
          >
            清空
          </button>
        </div>
        {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
      </div>
    </Dialog>
  )
}
