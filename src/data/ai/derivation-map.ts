/**
 * F8：AI 生成「生成元（最共性本义）→ 各 c」引申图（Mermaid/文字）。
 * 复用现有 provider / 超时 / 错误码 / Key 安全；结果只回 UI 预览，不自动保存。
 */
import { PROMPT_VERSION_DERIVATION_MAP, buildDerivationMapSystemPrompt, buildDerivationMapUserPrompt } from './prompts'
import type { DerivationMapSource } from './prompts'
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import type { AiConfig, TokenUsage } from './types'

export interface DerivationMapDraft {
  rootLabel: string
  mermaid?: string
  text?: string
}

export interface DerivationMapResult extends DerivationMapDraft {
  usage: TokenUsage
  promptVersion: string
}

export interface GenerateDerivationMapOptions {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 校验模型输出：rootLabel 必填；mermaid/text 至少一个；mermaid 必须 mindmap/flowchart */
export function validateDerivationMapDraft(raw: unknown): DerivationMapDraft {
  const obj = raw as { rootLabel?: unknown; mermaid?: unknown; text?: unknown } | null | undefined
  const rootLabel = nonEmpty(obj?.rootLabel)
  if (!rootLabel) throw new AiRequestError('AI_FORMAT', 'AI 返回缺少生成元（rootLabel）')
  const mermaid = nonEmpty(obj?.mermaid)
  const text = nonEmpty(obj?.text)
  if (!mermaid && !text) throw new AiRequestError('AI_FORMAT', 'AI 返回缺少 mermaid/text 引申图')
  if (mermaid && !/^\s*(mindmap|flowchart\s+(LR|TD|TB))/i.test(mermaid)) {
    throw new AiRequestError('AI_FORMAT', 'Mermaid 需为 mindmap 或 flowchart LR/TD')
  }
  return {
    rootLabel,
    ...(mermaid ? { mermaid } : {}),
    ...(text ? { text } : {}),
  }
}

/** AI 生成引申图（不写库；调用方负责预览/编辑/保存） */
export async function generateDerivationMap(
  source: DerivationMapSource,
  config: AiConfig,
  opts: GenerateDerivationMapOptions = {},
): Promise<DerivationMapResult> {
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const signal = opts.signal ?? new AbortController().signal
  const res = await provider.chat(
    {
      messages: [
        { role: 'system', content: buildDerivationMapSystemPrompt() },
        { role: 'user', content: buildDerivationMapUserPrompt(source) },
      ],
      temperature: 0.3,
      jsonMode: true,
    },
    config,
    signal,
  )
  const extracted = extractJsonObject(res.text)
  if (!extracted.json) {
    throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
  }
  const draft = validateDerivationMapDraft(extracted.json)
  return { ...draft, usage: res.usage, promptVersion: PROMPT_VERSION_DERIVATION_MAP }
}
