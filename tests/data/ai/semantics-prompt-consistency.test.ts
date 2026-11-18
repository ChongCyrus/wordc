/**
 * task-96 · canonical prompt 一致性测试
 *
 * 目的：docs/prompts/semantics-v4.md 是「外部 workflow / 子代理」复制走的文本，
 * 必须与 src/data/ai/prompts.ts 的 v4 函数**逐字一致**（App/CLI 走代码、外部走 md）。
 * 任何一侧改了 prompt 而另一侧没同步，本测试立刻失败。
 */
// @ts-expect-error 项目未装 @types/node（测试仅读取本地文档）
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PROMPT_VERSION_V4,
  SEMANTICS_JSON_SCHEMA_V4,
  buildSemanticsRepairPromptV4,
  buildSystemPromptV4,
  buildUserPromptV4,
} from '../../../src/data/ai/prompts'

const DOC_PATH = new URL('../../../docs/prompts/semantics-v4.md', import.meta.url)
const doc = readFileSync(DOC_PATH, 'utf8')

describe('semantics v4 canonical prompt 一致性', () => {
  it('版本号一致', () => {
    expect(PROMPT_VERSION_V4).toBe('v4.0-semantics-grouped')
    expect(doc).toContain(PROMPT_VERSION_V4)
  })

  it('md 含完整 system prompt（逐字）', () => {
    const system = buildSystemPromptV4().trim()
    expect(system.length).toBeGreaterThan(500)
    expect(doc).toContain(system)
  })

  it('md 含完整输出 schema（逐字）', () => {
    expect(doc).toContain(SEMANTICS_JSON_SCHEMA_V4.trim())
  })

  it('md 含 user prompt 模板与 repair prompt 关键行', () => {
    const user = buildUserPromptV4('apple', [{ cn: 'n. 苹果' }, { cn: 'n. 苹果公司' }])
    // user prompt 含动态 targets JSON，md 用示例替代；校验模板里的固定指令行
    expect(user).toContain('targets = ')
    expect(user).toContain('归纳 1–4 个「本义」')
    expect(doc).toContain('归纳 1–4 个「本义」')

    const repair = buildSemanticsRepairPromptV4('USER_PROMPT_TEXT', 'E_TEST')
    expect(repair).toContain('你的输出不符合 v4 要求')
    expect(doc).toContain('你的输出不符合 v4 要求')
  })

  it('md 明确强制规则与配套引用', () => {
    expect(doc).toContain('必须使用本文件')
    expect(doc).toContain('SEMANTICS-FORMAT.md')
    expect(doc).toContain('meta.promptVersion')
  })
})
