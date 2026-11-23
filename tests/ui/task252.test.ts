import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const memory = src('ui/study/components/MemoryStage.tsx')
const gen = src('ui/study/components/GenerativeMemoryStage.tsx')
const page = src('ui/study/StudyPage.tsx')

describe('task-252 移除自动 advance', () => {
  it('handleMemoryTap 只调 tapMemory；无 220ms advance timer', () => {
    const hook = src('ui/study/hooks/useStudySession.ts')
    expect(hook).not.toContain('advanceTimerRef')
    expect(hook).toContain('const tapped = tapMemory(current)')
    expect(hook).not.toContain('const advanced = advanceMemory(current)')
  })
})

describe('task-252 卡片刷新动画开关', () => {
  it('默认关闭用静态 key，不重挂载；开启才按 count 变化', () => {
    expect(memory).toContain('cardFlashAnimation = false')
    expect(memory).toContain(": 'memory-card'")
    expect(memory).toContain('cardFlashAnimation')
    expect(memory).toContain('? `memory-card-${safeCount}`')
    expect(gen).toContain('cardFlashAnimation = false')
    expect(gen).toContain(": 'gen-card'")
    expect(gen).toContain('cardFlashAnimation ? `gen-count-${count}`')
  })

  it('StudyPage 从 memory.cardFlashAnimation 读取并传两处', () => {
    expect(page).toContain("'memory.cardFlashAnimation'")
    expect(src('ui/study/styles/study.css')).toContain('.wc-card--flash { animation: study-card-in')
    expect((page.match(/cardFlashAnimation=/g) ?? []).length).toBeGreaterThanOrEqual(2)
    const css = src('ui/study/styles/study.css')
    expect(css).not.toMatch(/\.wc-card \{[^}]*animation:/)
  })
})
