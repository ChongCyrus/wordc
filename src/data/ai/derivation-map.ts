/**
 * F8：AI 生成「生成元（最共性本义）→ 各 c」引申图（Mermaid/文字）。
 * 复用现有 provider / 超时 / 错误码 / Key 安全；结果只回 UI 预览，不自动保存。
 */
import { PROMPT_VERSION_DERIVATION_MAP, buildDerivationMapSystemPrompt, buildDerivationMapUserPrompt } from './prompts'
import type { DerivationMapSource } from './prompts'
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import type { AiConfig, TokenUsage } from './types'

export interface DerivationMapLine {
  /** 对应 text 中某个「- 」行（可包含/不含前缀「- 」） */
  text: string
  /** 该行对应的输入 c index（从 1 起；不得编造） */
  meaningIndexes: number[]
}

export interface DerivationMapDraft {
  rootLabel: string
  mermaid?: string
  text?: string
  /** task-165：text 每条 `- ` 行 → c index 映射；旧数据无此字段兼容 */
  lines?: DerivationMapLine[]
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
  const obj = raw as { rootLabel?: unknown; mermaid?: unknown; text?: unknown; lines?: unknown } | null | undefined
  const rootLabel = nonEmpty(obj?.rootLabel)
  if (!rootLabel) throw new AiRequestError('AI_FORMAT', 'AI 返回缺少生成元（rootLabel）')
  const mermaid = nonEmpty(obj?.mermaid)
  const text = nonEmpty(obj?.text)
  if (!mermaid && !text) throw new AiRequestError('AI_FORMAT', 'AI 返回缺少 mermaid/text 引申图')
  if (mermaid && !/^\s*(mindmap|flowchart\s+(LR|TD|TB))/i.test(mermaid)) {
    throw new AiRequestError('AI_FORMAT', 'Mermaid 需为 mindmap 或 flowchart LR/TD')
  }
  // task-165：lines 可选（旧数据无 lines 兼容）；存在时严格校验
  let lines: DerivationMapLine[] | undefined
  if (obj?.lines !== undefined && obj.lines !== null) {
    if (!Array.isArray(obj.lines)) throw new AiRequestError('AI_FORMAT', 'lines 必须是数组')
    lines = obj.lines.map((entry, index) => {
      const line = entry as { text?: unknown; meaningIndexes?: unknown } | null
      const lineText = nonEmpty(line?.text)
      if (!lineText) throw new AiRequestError('AI_FORMAT', `lines[${index}] 缺少 text`)
      if (!Array.isArray(line?.meaningIndexes) || line.meaningIndexes.length === 0) {
        throw new AiRequestError('AI_FORMAT', `lines[${index}] meaningIndexes 必须是非空数组`)
      }
      const meaningIndexes = [...new Set(
        line.meaningIndexes.map((value) => {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
            throw new AiRequestError('AI_FORMAT', `lines[${index}] meaningIndexes 必须是正整数`)
          }
          return value
        }),
      )]
      return { text: lineText, meaningIndexes }
    })
    // 若 text 含「- 」行，要求每条都有对应 lines，且正文一致（允许 lines.text 去掉「- 」前缀）
    const bulletLines = (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
    if (bulletLines.length > 0) {
      if (lines.length !== bulletLines.length) {
        throw new AiRequestError('AI_FORMAT', 'lines 必须与 text 的「- 」行一一对应')
      }
      for (let i = 0; i < bulletLines.length; i += 1) {
        const lineText = lines[i]!.text.replace(/^-\s+/, '').trim()
        if (lineText !== bulletLines[i]) {
          throw new AiRequestError('AI_FORMAT', 'lines.text 必须与 text 对应行一致')
        }
      }
    }
  }
  return {
    rootLabel,
    ...(mermaid ? { mermaid } : {}),
    ...(text ? { text } : {}),
    ...(lines ? { lines } : {}),
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
