import { useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { aiErrorMessage } from '../../../app/hooks/aiUi'
import {
  collectSenseMnemonicSources,
  generateCoreSenseExamples,
  generateCoreSensePhrases,
  generateSenseMnemonic,
  getCoreSenseRepresentative,
  getEffectiveContent,
  getWord,
  loadAiConfig,
  saveCoreSenseExamples,
  saveCoreSensePhrases,
  saveSenseMnemonic,
} from '../../../data'

export function CoreSenseAIPanel({
  open,
  wordId,
  word,
  coreSenseIndex,
  label,
  exampleCount,
  phraseCount,
  onClose,
  onChanged,
}: {
  open: boolean
  wordId: string
  word: string
  coreSenseIndex: number
  label: string
  exampleCount: number
  phraseCount: number
  onClose: () => void
  onChanged?: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mnemonicPreview, setMnemonicPreview] = useState<string | null>(null)
  const [examplesPreview, setExamplesPreview] = useState<Array<{ en: string; cn: string }> | null>(null)
  const [phrasesPreview, setPhrasesPreview] = useState<Array<{ en: string; cn: string }> | null>(null)

  const ensureConfig = async () => {
    const config = await loadAiConfig()
    if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
    return config
  }

  const buildSource = async () => {
    const [effective, wordRow, representative] = await Promise.all([
      getEffectiveContent(wordId),
      getWord(wordId),
      getCoreSenseRepresentative(wordId, coreSenseIndex, 3),
    ])
    const meaningMap = effective?.meaningMap ?? []
    const mappedMeanings = meaningMap
      .filter((mapping) => mapping.coreSenseIndex === coreSenseIndex)
      .map((mapping) => {
        const meaning = wordRow?.meanings?.[mapping.meaningIndex - 1]
        return {
          meaningIndex: mapping.meaningIndex,
          cn: meaning?.cn ?? '',
          ...(meaning?.pos ? { pos: meaning.pos } : {}),
        }
      })
      .filter((item) => Boolean(item.cn))
    return {
      word,
      label,
      coreSenseIndex,
      ...(effective?.coreSenses?.[coreSenseIndex - 1]?.note
        ? { gloss: effective.coreSenses[coreSenseIndex - 1]!.note }
        : {}),
      ...(effective?.coreSenses?.[coreSenseIndex - 1]?.origin
        ? { origin: effective.coreSenses[coreSenseIndex - 1]!.origin }
        : {}),
      mappedMeanings,
      ...(representative?.representativeMeaningId
        ? {
            representative: (() => {
              const mapped = mappedMeanings.find(
                (item) => meaningMap.some((mapping) => mapping.meaningIndex === item.meaningIndex && mapping.coreSenseIndex === coreSenseIndex),
              )
              return mapped
                ? {
                    meaningIndex: mapped.meaningIndex,
                    cn: mapped.cn,
                    ...(representative.examples.length > 0
                      ? { examples: representative.examples }
                      : {}),
                  }
                : undefined
            })(),
          }
        : {}),
    }
  }

  const runMnemonic = async () => {
    setBusy('mnemonic')
    setError(null)
    try {
      const config = await ensureConfig()
      const sources = await collectSenseMnemonicSources(
        { scope: 'word', wordId },
        { includeExisting: true, includeRare: true },
      )
      const source = sources.find((item) => item.coreSenseIndex === coreSenseIndex)
      if (!source) throw new Error('找不到当前本义数据')
      const result = await generateSenseMnemonic(source, config)
      setMnemonicPreview(result.mnemonic)
    } catch (err) {
      setError(aiErrorMessage((err as { code?: string })?.code, 'AI 生成本义助记失败'))
    } finally {
      setBusy(null)
    }
  }

  const runExamples = async () => {
    if (exampleCount <= 0) return
    setBusy('examples')
    setError(null)
    try {
      const config = await ensureConfig()
      const source = { ...(await buildSource()), count: exampleCount }
      const result = await generateCoreSenseExamples(source, config)
      setExamplesPreview(result.examples)
    } catch (err) {
      setError(aiErrorMessage((err as { code?: string })?.code, 'AI 生成本义例句失败'))
    } finally {
      setBusy(null)
    }
  }

  const runPhrases = async () => {
    if (phraseCount <= 0) return
    setBusy('phrases')
    setError(null)
    try {
      const config = await ensureConfig()
      const source = { ...(await buildSource()), count: phraseCount }
      const result = await generateCoreSensePhrases(source, config)
      setPhrasesPreview(result.phrases)
    } catch (err) {
      setError(aiErrorMessage((err as { code?: string })?.code, 'AI 生成本义词组失败'))
    } finally {
      setBusy(null)
    }
  }

  const save = async (kind: 'mnemonic' | 'examples' | 'phrases') => {
    setBusy('save')
    setError(null)
    try {
      if (kind === 'mnemonic' && mnemonicPreview) {
        await saveSenseMnemonic(wordId, {
          coreSenseIndex,
          label,
          text: mnemonicPreview,
          source: 'ai',
        })
      } else if (kind === 'examples' && examplesPreview) {
        await saveCoreSenseExamples(wordId, {
          coreSenseIndex,
          label,
          examples: examplesPreview,
          source: 'ai',
        })
      } else if (kind === 'phrases' && phrasesPreview) {
        await saveCoreSensePhrases(wordId, {
          coreSenseIndex,
          label,
          phrases: phrasesPreview,
          source: 'ai',
        })
      }
      onChanged?.()
      setMnemonicPreview(null)
      setExamplesPreview(null)
      setPhrasesPreview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      title={`本义 AI · 本义${coreSenseIndex}「${label}」`}
      onClose={onClose}
      overlayClassName="mm-mask--above-generative"
      dismissable={!busy}
      actions={
        <button type="button" className="mm-btn" onClick={onClose} disabled={Boolean(busy)}>
          关闭
        </button>
      }
    >
      <div className="core-sense-ai-panel">
        <div className="mm-caption">AI 结果先预览，确认保存后才覆盖当前本义内容。</div>
        <div className="core-sense-ai-section">
          <button type="button" className="mm-btn" disabled={Boolean(busy)} onClick={() => void runMnemonic()}>
            AI 生成本义助记
          </button>
          {mnemonicPreview ? (
            <div className="core-sense-ai-preview">
              <div className="mm-caption">本义助记预览：{mnemonicPreview}</div>
              <button type="button" className="mm-btn mm-btn--primary" disabled={busy === 'save'} onClick={() => void save('mnemonic')}>
                保存本义助记
              </button>
            </div>
          ) : null}
        </div>
        <div className="core-sense-ai-section">
          <button
            type="button"
            className="mm-btn"
            disabled={Boolean(busy) || exampleCount <= 0}
            onClick={() => void runExamples()}
          >
            AI 生成本义例句
          </button>
          {exampleCount <= 0 ? <div className="mm-caption">例句数量为 0（可在设置调整）</div> : null}
          {examplesPreview ? (
            <div className="core-sense-ai-preview">
              {examplesPreview.map((example, index) => (
                <div className="wc-info-example" key={`${example.en}-${index}`}>
                  <span className="wc-info-en">{example.en}</span>
                  <span className="wc-info-cn">{example.cn}</span>
                </div>
              ))}
              <button type="button" className="mm-btn mm-btn--primary" disabled={busy === 'save'} onClick={() => void save('examples')}>
                保存本义例句
              </button>
            </div>
          ) : null}
        </div>
        <div className="core-sense-ai-section">
          <button
            type="button"
            className="mm-btn"
            disabled={Boolean(busy) || phraseCount <= 0}
            onClick={() => void runPhrases()}
          >
            AI 生成本义词组
          </button>
          {phraseCount <= 0 ? <div className="mm-caption">词组数量为 0（可在设置调整）</div> : null}
          {phrasesPreview ? (
            <div className="core-sense-ai-preview">
              {phrasesPreview.map((phrase, index) => (
                <div className="wc-phrase-line" key={`${phrase.en}-${index}`}>
                  {phrase.en} — {phrase.cn}
                </div>
              ))}
              <button type="button" className="mm-btn mm-btn--primary" disabled={busy === 'save'} onClick={() => void save('phrases')}>
                保存本义词组
              </button>
            </div>
          ) : null}
        </div>
        {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
      </div>
    </Dialog>
  )
}
