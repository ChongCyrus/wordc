import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { createSession, sessionMeaningIdOf } from '../../src/core'

const hook = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/hooks/useStudySession.ts', import.meta.url)),
  'utf8',
)

describe('task-236 Word.meanings(id) → SessionWord.meaningId', () => {
  it('createSession 统一把 id 映射成 meaningId', () => {
    const session = createSession({
      word: {
        wordId: 'deck:denounce',
        deckId: 'deck',
        headword: 'denounce',
        meanings: [{ id: 'M1', cn: '公开宣告' }],
        phrases: [],
      } as never,
      settings: {
        totalRepeats: 3,
        mode: 'sequential',
        showPhrases: false,
        exampleCount: 0,
        showPhonetic: false,
        threeTapRecall: false,
      },
    })
    expect(session.word.meanings[0]?.meaningId).toBe('M1')
  })

  it('兼容读取 helper + weighted 分支使用 helper', () => {
    expect(sessionMeaningIdOf({ id: 'M1' })).toBe('M1')
    expect(sessionMeaningIdOf({ meaningId: 'M2' })).toBe('M2')
    expect(hook).toContain('sessionMeaningIdOf(')
    expect(hook).toContain('latestMeaningStats[meaningKey]')
  })
})
