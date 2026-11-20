import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getWordDetailBundle, rateTempReview, startTempReview } from '../../data'
import type { TempReviewSession } from '../../data'
import type { Rating } from '../../core'
import type { UserMnemonicView, UserNoteView } from './components/types'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { Button } from '../components/Buttons'
import { AnnotationStage } from './components/AnnotationStage'
import type { TempRecordMode } from '../components/ReviewChoiceDialog'

const RATINGS: Array<{ rating: Rating; label: string }> = [
  { rating: 'familiar', label: '认识' },
  { rating: 'vague', label: '模糊' },
  { rating: 'forgot', label: '不认识' },
]

/** 临时复习页：只包含所选词，一次性；结束回来源页 */
export default function TempReviewPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const wordIds = (params.get('words') ?? '').split(',').filter(Boolean)
  const recordMode = (params.get('recordMode') ?? 'rate') as TempRecordMode
  const returnTo = params.get('returnTo') ?? '/'
  const [session, setSession] = useState<TempReviewSession | null>(null)
  const [index, setIndex] = useState(0)
  const [notes, setNotes] = useState<UserNoteView[]>([])
  const [userMnemonics, setUserMnemonics] = useState<UserMnemonicView[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void startTempReview({ wordIds, recordMode })
      .then(setSession)
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : '创建临时复习失败')
        navigate(returnTo)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const word = session?.words[index] ?? null
  useEffect(() => {
    if (!word) return
    let alive = true
    void getWordDetailBundle(word.id).then((bundle) => {
      if (!alive || !bundle) return
      setNotes(bundle.userNotes as UserNoteView[])
      setUserMnemonics(bundle.userMnemonics as UserMnemonicView[])
    })
    return () => {
      alive = false
    }
  }, [word?.id])

  const next = () => {
    if (!session) return
    if (index + 1 >= session.words.length) {
      toast.success('临时复习完成')
      navigate(returnTo, { replace: true })
      return
    }
    setIndex((value) => value + 1)
  }

  const rate = async (rating: Rating) => {
    if (!word || !session || busy) return
    setBusy(true)
    try {
      await rateTempReview({ wordId: word.id, rating, recordMode: session.recordMode })
      next()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '评分失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell
      title={session ? `临时复习 ${index + 1}/${session.words.length}` : '临时复习'}
      backTo={returnTo}
    >
      {!word ? (
        <div className="mm-caption">加载中…</div>
      ) : (
        <>
          <AnnotationStage
            headword={word.headword}
            phonetic={word.phonetic?.us ?? word.phonetic?.uk}
            showPhonetic
            meanings={word.meanings.map((meaning) => ({
              meaningId: meaning.id,
              pos: meaning.pos,
              cn: meaning.cn,
              clicks: 0,
              encounters: 0,
              familiarity: null,
              examples: meaning.examples?.map((example) => ({ en: example.en, cn: example.cn ?? '' })),
            }))}
            examples={(word.examples ?? []).map((example) => ({ en: example.en, cn: example.cn }))}
            mnemonics={(word.mnemonics ?? []).map((m) => ({ type: m.type, text: m.text }))}
            phrases={(word.phrases ?? []).map((phrase) => ({ en: phrase.en, cn: phrase.cn, meaningId: phrase.meaningId }))}
            showPhrases
            userNotes={notes}
            userMnemonics={userMnemonics}
            onSpeak={() => undefined}
            onMarkMeaning={() => undefined}
            hideRareBlocks
          />
          <div className="temp-review-actions">
            {recordMode === 'practice' ? (
              <Button variant="primary" block onClick={next}>
                下一个
              </Button>
            ) : (
              RATINGS.map((item) => (
                <Button key={item.rating} variant="soft" disabled={busy} onClick={() => void rate(item.rating)}>
                  {item.label}
                </Button>
              ))
            )}
          </div>
        </>
      )}
    </PageShell>
  )
}
