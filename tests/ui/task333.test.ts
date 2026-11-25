import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const toggle = src('ui/components/ThemeToggleButton.tsx')
const ie = src('ui/me/ImportExportPage.tsx')

describe('task-333 rc3 主题长按/词根缀源导入', () => {
  it('650ms 定时器 + longPressFired，click 不覆盖 system', () => {
    expect(toggle).toContain('longPressFiredRef')
    expect(toggle).toContain('650')
    expect(toggle).toContain('onPointerDown')
    expect(toggle).toContain('onPointerUp')
    expect(toggle).toContain('onPointerCancel')
    expect(toggle).toContain('if (longPressFiredRef.current)')
  })

  it('词根缀源导入：preBackup→bundle 校验→import→counts/error toast+刷新', () => {
    expect(ie).toContain('importRootEtymologyBundle(parsed')
    expect(ie).toContain("setBusy('导入词根缀源…')")
    expect(ie).toContain('disabled={busy !== null}')
    expect(ie).toContain('isRootEtymologyBundle(parsed)')
    expect(ie).toContain('importRootEtymologyBundle(parsed')
    expect(ie).toContain('更新 ${report.updated}')
    expect(ie).toContain('跳过手改 ${report.skippedManual}')
    expect(ie).toContain('缺词 ${report.skippedMissing}')
    expect(ie).toContain('momo:generated-seed-updated')
  })
})
