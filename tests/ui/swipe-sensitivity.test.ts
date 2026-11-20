import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import {
  clampSwipeSensitivity,
  readSwipeSensitivity,
} from '../../src/ui/study/lib/derivation-width'

const settingsPage = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/SettingsPage.tsx', import.meta.url)),
  'utf8',
)
const studyPage = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
  'utf8',
)

describe('右页滑动灵敏度（task-191）', () => {
  it('clamp 0.2–3.0、默认 1.0、步进 0.1', () => {
    expect(clampSwipeSensitivity(0.1)).toBe(0.2)
    expect(clampSwipeSensitivity(9)).toBe(3)
    expect(clampSwipeSensitivity(Number.NaN)).toBe(1)
    expect(clampSwipeSensitivity(undefined)).toBe(1)
    expect(clampSwipeSensitivity(1.26)).toBe(1.3)
    expect(clampSwipeSensitivity(2.97)).toBe(3)
  })

  it('从 settings 读取，缺失回退 1.0', () => {
    expect(readSwipeSensitivity({ 'derivation.swipeSensitivity': 2.2 })).toBe(2.2)
    expect(readSwipeSensitivity({})).toBe(1)
    expect(readSwipeSensitivity(null)).toBe(1)
    expect(readSwipeSensitivity({ 'derivation.swipeSensitivity': 99 })).toBe(3)
  })

  it('设置页渲染滑块并写 derivation.swipeSensitivity；StudyPage 传给手势 hook', () => {
    expect(settingsPage).toContain('右页滑动灵敏度')
    expect(settingsPage).toContain("'derivation.swipeSensitivity'")
    expect(settingsPage).toContain('min={0.2}')
    expect(settingsPage).toContain('max={3}')
    expect(settingsPage).toContain('step={0.1}')
    expect(settingsPage).toContain('clampSwipeSensitivity(value)')
    expect(studyPage).toContain('sensitivity: readSwipeSensitivity(settings)')
  })
})
