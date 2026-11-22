import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  deleteWord,
  getEffectiveContent,
  getState,
  getWord,
  listUserMnemonics,
  listUserNotes,
} from '../../data'
import type { Word, WordState } from '../../core'
import { familiarity } from '../../core'
import type { UserMnemonicView, UserNoteView } from '../study/components/types'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { Button } from '../components/Buttons'
import { AnnotationStage } from '../study/components/AnnotationStage'

/** task-261 B：词库单词全屏详情，展示与注释面一致（无评分按钮） */
export default function WordDetailPage() {
  const { deckId = '', wordId = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [word, setWord] = useState<Word | null>(null)
  const [state, setState] = useState<WordState | null>(null)
  const [notes, setNotes] = useState<UserNoteView[]>([])
  const [userMnemonics, setUserMnemonics] = useState<UserMnemonicView[]>([])
  const [coreSenses, setCoreSenses] = useState<Array<{ label: string; note?: string; origin?: string }>>([])
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([
      getWord(wordId),
      getState(wordId),
      listUserNotes(wordId).catch(() => []),
      listUserMnemonics(wordId).catch(() => []),
      getEffectiveContent(wordId).catch(() => null),
    ]).then(([row, st, noteRows, mnemonicRows, effective]) => {
      if (!alive) return
      setWord(row ?? null)
      setState(st ?? null)
      setNotes((noteRows ?? []) as UserNoteView[])
      setUserMnemonics((mnemonicRows ?? []) as UserMnemonicView[])
      setCoreSenses((effective?.coreSenses ?? []).map((sense) => ({ label: sense.label, note: sense.note, origin: sense.origin })))
    })
    return () => {
      alive = false
    }
  }, [wordId])

  const remove = async () => {
    if (!word) return
    setDeleting(true)
    try {
      await deleteWord(word.id)
      toast.success('已删除单词')
      navigate(`/decks/${deckId}`, { replace: true })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  if (!word) {
    return (
      <PageShell title="单词详情" backTo={`/decks/${deckId}`}>
        <div className="mm-caption">加载中…</div>
      </PageShell>
    )
  }

  const meanings = word.meanings.map((meaning) => {
    const stat = state?.meaningStats?.[meaning.id]
    return {
      meaningId: meaning.id,
      pos: meaning.pos,
      cn: meaning.cn,
      clicks: stat?.clicks ?? 0,
      encounters: stat?.encounters ?? 0,
      familiarity: stat ? familiarity(stat.clicks, stat.encounters) : null,
      examples: meaning.examples?.map((example) => ({ en: example.en, cn: example.cn ?? '' })),
    }
  })
  const coreStats = state?.coreSenseStats ?? {}
  const coreFamiliarityByIndex = Object.fromEntries(
    coreSenses.map((sense, index) => {
      const stat = coreStats[`${index + 1}:${sense.label}`] as { clicks: number; encounters: number } | undefined
      return [index + 1, stat ? familiarity(stat.clicks, stat.encounters) : null]
    }),
  )

  return (
    <PageShell
      title={word.headword}
      backTo={`/decks/${deckId}`}
      actions={
        <>
          <Button
            variant="soft"
            size="sm"
            onClick={() => navigate(`/decks/${deckId}?edit=${encodeURIComponent(word.id)}`)}
          >
            编辑
          </Button>
          <Button variant="danger" size="sm" disabled={deleting} onClick={() => void remove()}>
            {deleting ? '删除中…' : '删除'}
          </Button>
        </>
      }
    >
      <AnnotationStage
        headword={word.headword}
        phonetic={word.phonetic?.us ?? word.phonetic?.uk}
        showPhonetic
        coreSenses={coreSenses}
        coreSenseFamiliarityByIndex={coreFamiliarityByIndex}
        meanings={meanings}
        examples={(word.examples ?? []).map((example) => ({ en: example.en, cn: example.cn }))}
        mnemonics={(word.mnemonics ?? []).map((mnemonic) => ({ type: mnemonic.type, text: mnemonic.text }))}
        phrases={(word.phrases ?? []).map((phrase) => ({ en: phrase.en, cn: phrase.cn, meaningId: phrase.meaningId }))}
        showPhrases
        userNotes={notes}
        userMnemonics={userMnemonics}
        onSpeak={() => undefined}
        onMarkMeaning={() => undefined}
        hideRareBlocks
      />
      <div className="mm-caption" style={{ paddingTop: 12 }}>
        该页只展示注释内容，不提供认识/模糊/不认识评分；编辑/删除不影响学习进度。
      </div>
    </PageShell>
  )
}
