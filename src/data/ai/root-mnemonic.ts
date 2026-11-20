/** 0.3.61：AI 生成「单词 w→生成元」映射助记（1–3 条中文）。结果只回 UI 预览，不自动写库。 */
import {
  PROMPT_VERSION_ROOT_MNEMONIC,
  buildRootMnemonicSystemPrompt,
  buildRootMnemonicUserPrompt,
  type RootMnemonicPromptSource,
} from './prompts'
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import type { AiConfig, TokenUsage } from './types'

export interface RootMnemonicGenerateResult {
  mnemonics: string[]
  usage: TokenUsage
  promptVersion: string
}

export interface GenerateRootMnemonicOptions {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** 校验模型输出：1–3 条非空中文助记 */
export function validateRootMnemonicDraft(raw: unknown): string[] {
  const obj = raw as { mnemonics?: unknown } | null | undefined
  if (!obj || !Array.isArray(obj.mnemonics)) {
    throw new AiRequestError('AI_FORMAT', 'AI 返回缺少 mnemonics 数组')
  }
  const texts = obj.mnemonics
    .map((item) => {
      const text = typeof item === 'string' ? item : (item as { text?: unknown } | null)?.text
      return typeof text === 'string' ? text.trim() : ''
    })
    .filter(Boolean)
  if (texts.length < 1 || texts.length > 3) {
    throw new AiRequestError('AI_FORMAT', '助记需 1–3 条非空中文')
  }
  return [...new Set(texts)]
}

export async function generateRootMnemonic(
  source: RootMnemonicPromptSource,
  config: AiConfig,
  opts: GenerateRootMnemonicOptions = {},
): Promise<RootMnemonicGenerateResult> {
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const signal = opts.signal ?? new AbortController().signal
  const res = await provider.chat(
    {
      messages: [
        { role: 'system', content: buildRootMnemonicSystemPrompt() },
        { role: 'user', content: buildRootMnemonicUserPrompt(source) },
      ],
      temperature: 0.5,
      jsonMode: true,
    },
    config,
    signal,
  )
  const extracted = extractJsonObject(res.text)
  if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
  return {
    mnemonics: validateRootMnemonicDraft(extracted.json),
    usage: res.usage,
    promptVersion: PROMPT_VERSION_ROOT_MNEMONIC,
  }
}
