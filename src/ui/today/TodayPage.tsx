import { useState } from 'react'
import type { Word } from '../../core'
import { getWord } from '../../data'
import { useToast } from '../../app/toast'
import { useTodayBreakdown } from '../../app/hooks/useTodayBreakdown'
import { useHomeStudy } from '../../app/hooks/useHomeStudy'
import { PageShell } from '../components/PageShell'
import { Sheet } from '../components/Sheet'
import { TodayWordsView } from './TodayWordsView'
import type { TodayWordView } from './today-types'
import { wordTags } from './today-types'

/** 单词详情弹层（复用词库页的底部 sheet 样式；今日单词页专用轻量版） */
function TodayWordSheet({ word, onClose }: { word: Word | null; onClose: () => void }) {
  return (
    <Sheet open={word != null} title={word?.headword ?? ''} onClose={onClose}>
      {word ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 8 }}>
          {word.phonetic?.us || word.phonetic?.uk ? (
            <div className="mm-caption">{word.phonetic.us ?? word.phonetic.uk}</div>
          ) : null}
          {word.meanings.map((meaning) => (
            <div key={meaning.id} style={{ fontSize: 'var(--mm-text-title)' }}>
              {meaning.pos ? <span className="mm-muted">{meaning.pos} </span> : null}
              {meaning.cn}
            </div>
          ))}
          {word.examples.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="mm-caption">例句</span>
              {word.examples.slice(0, 3).map((example, index) => (
                <div key={`${example.en}-${index}`}>
                  <div style={{ fontSize: 'var(--mm-text-body-sm)' }}>{example.en}</div>
                  {example.cn ? <div className="mm-row-sub">{example.cn}</div> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  )
}

/**
 * 「今日单词」页（task-50）：复习 / 新学两分区，列出 planned/learned 与每个词的标签
 * （评分/未学/加学/回炉），点击查看单词详情。数据来自 useTodayBreakdown（task-49）。
 */
export default function TodayPage() {
  const toast = useToast()
  const { breakdown, loading } = useTodayBreakdown()
  const { data: homeData } = useHomeStudy()
  const reviewBacklog = (
    homeData as unknown as { reviewBacklog?: number } | null
  )?.reviewBacklog
  const [selected, setSelected] = useState<Word | null>(null)

  const handleSelect = async (item: TodayWordView) => {
    try {
      const word = await getWord(item.wordId)
      if (!word) {
        toast.error('单词不存在或已被删除')
        return
      }
      setSelected(word)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载单词失败')
    }
  }

  return (
    <PageShell title="今日单词" backTo="/">
      {loading ? (
        <div className="mm-loading">正在加载今日单词…</div>
      ) : (
        <TodayWordsView
          breakdown={breakdown}
          reviewBacklog={reviewBacklog}
          onSelectWord={(word) => void handleSelect(word)}
        />
      )}
      <TodayWordSheet word={selected} onClose={() => setSelected(null)} />
    </PageShell>
  )
}

/** 供单测/复用：给定 item 的标签（已学评分/未学/加学/回炉） */
export { wordTags }
