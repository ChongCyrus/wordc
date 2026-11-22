/**
 * task-164 A9：右半页引申图 JSON 导入/导出（schema + 校验）。
 * 文件 schema：{format:'wordc-derivation', formatVersion:1, word, rootLabel, text?, mermaid?, lines?}
 */
import type { DerivationMap } from '../core/types'

export const DERIVATION_JSON_FORMAT = 'wordc-derivation' as const
export const DERIVATION_JSON_VERSION = 1 as const

export interface DerivationJsonLine {
  text: string
  meaningIndexes: number[]
}

export interface DerivationJson {
  format: typeof DERIVATION_JSON_FORMAT
  formatVersion: typeof DERIVATION_JSON_VERSION
  word: string
  rootLabel: string
  text?: string
  mermaid?: string
  lines?: DerivationJsonLine[]
}

export type DerivationJsonParseResult =
  | { ok: true; value: DerivationJson }
  | { ok: false; errors: string[] }

/** 从 DerivationMap 构造导出对象（不含 source/updatedAt，便于手工编辑/分享） */
export function buildDerivationJson(word: string, map: DerivationMap): DerivationJson {
  const out: DerivationJson = {
    format: DERIVATION_JSON_FORMAT,
    formatVersion: DERIVATION_JSON_VERSION,
    word: String(word ?? '').trim(),
    rootLabel: String(map.rootLabel ?? '').trim(),
  }
  if (map.text?.trim()) out.text = map.text.trim()
  if (map.mermaid?.trim()) out.mermaid = map.mermaid.trim()
  if (map.lines && map.lines.length > 0) {
    out.lines = map.lines.map((line) => ({ text: line.text.trim(), meaningIndexes: [...line.meaningIndexes] }))
  }
  return out
}

/** 解析/校验右页 JSON（字符串或已解析对象）；返回结构化错误列表 */
export function parseDerivationJson(input: string | unknown): DerivationJsonParseResult {
  const errors: string[] = []
  let raw: unknown
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch (error) {
      return { ok: false, errors: [`JSON 解析失败：${(error as Error).message}`] }
    }
  } else {
    raw = input
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['文件不是 JSON 对象'] }
  }
  const obj = raw as Record<string, unknown>
  if (obj.format !== DERIVATION_JSON_FORMAT) errors.push(`format 应为 ${DERIVATION_JSON_FORMAT}`)
  if (obj.formatVersion !== DERIVATION_JSON_VERSION) {
    errors.push(`formatVersion 应为 ${DERIVATION_JSON_VERSION}（当前 ${String(obj.formatVersion)}）`)
  }
  const word = typeof obj.word === 'string' ? obj.word.trim() : ''
  if (!word) errors.push('word 不能为空')
  const rootLabel = typeof obj.rootLabel === 'string' ? obj.rootLabel.trim() : ''
  if (!rootLabel) errors.push('rootLabel 不能为空')
  const text = typeof obj.text === 'string' ? obj.text.trim() : undefined
  const mermaid = typeof obj.mermaid === 'string' ? obj.mermaid.trim() : undefined
  let lines: DerivationJsonLine[] | undefined
  if (obj.lines !== undefined) {
    if (!Array.isArray(obj.lines)) errors.push('lines 必须是数组')
    else {
      const collected: DerivationJsonLine[] = []
      obj.lines.forEach((line, index) => {
        if (!line || typeof line !== 'object') {
          errors.push(`lines[${index}] 不是对象`)
          return
        }
        const item = line as Record<string, unknown>
        const lineText = typeof item.text === 'string' ? item.text.trim() : ''
        if (!lineText) errors.push(`lines[${index}].text 不能为空`)
        const indexes = Array.isArray(item.meaningIndexes) ? item.meaningIndexes : null
        if (!indexes || indexes.length === 0) errors.push(`lines[${index}].meaningIndexes 必须是非空数组`)
        const validIndexes = (indexes ?? []).filter(
          (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1,
        )
        if (indexes && validIndexes.length !== indexes.length) {
          errors.push(`lines[${index}].meaningIndexes 只能是 ≥1 的整数`)
        }
        if (lineText && validIndexes.length > 0) {
          collected.push({ text: lineText, meaningIndexes: [...new Set(validIndexes)].sort((a, b) => a - b) })
        }
      })
      lines = collected
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      format: DERIVATION_JSON_FORMAT,
      formatVersion: DERIVATION_JSON_VERSION,
      word,
      rootLabel,
      ...(text ? { text } : {}),
      ...(mermaid ? { mermaid } : {}),
      ...(lines !== undefined && lines.length > 0 ? { lines } : {}),
    },
  }
}
