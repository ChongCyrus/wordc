import { useEffect, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { aiErrorMessage } from '../../../app/hooks/aiUi'
import {
  clearSenseMnemonic,
  collectSenseMnemonicSources,
  generateSenseMnemonic,
  loadAiConfig,
  saveSenseMnemonic,
} from '../../../data'
import { MultilineTextarea } from '../../components/MultilineTextarea'

/** task-231：注释面点本义助记段落 → 只开编辑窗；独立叠加在面板/评分栏之上 */
export function SenseMnemonicEditDialog({
  open,
  wordId,
  word,
  coreSenseIndex,
  label,
  initialText,
  onClose,
  onChanged,
}: {
  open: boolean
  wordId: string
  word: string
  coreSenseIndex: number
  label: string
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
    setError(null)
    setBusy(false)
  }, [open, initialText, coreSenseIndex])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveSenseMnemonic(wordId, {
        coreSenseIndex,
        label,
        text: text.trim(),
        source: 'manual',
      })
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
      const sources = await collectSenseMnemonicSources(
        { scope: 'word', wordId },
        { includeExisting: true, includeRare: true },
      )
      const source = sources.find((item) => item.coreSenseIndex === coreSenseIndex)
      if (!source) throw new Error('找不到当前本义数据')
      const result = await generateSenseMnemonic(source, config)
      setText(result.mnemonic)
    } catch (err) {
      setError(aiErrorMessage((err as { code?: string })?.code, '生成失败'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await clearSenseMnemonic(wordId, { coreSenseIndex, label })
      onChanged?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      title={`编辑本义助记 · ${word} · 本义${coreSenseIndex}「${label}」`}
      overlayClassName="mm-mask--above-rating-edit"
      testId="sense-edit-dialog"
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
          aria-label="本义助记内容"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="mm-btn-row">
          <button type="button" className="mm-btn" disabled={busy} onClick={() => void regenerate()}>
            重新生成
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--danger"
            disabled={busy || !text.trim()}
            onClick={() => void remove()}
          >
            删除
          </button>
        </div>
        {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
      </div>
    </Dialog>
  )
}
